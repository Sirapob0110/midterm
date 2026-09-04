const { pool } = require("../db");
const { redisClient } = require("../cache");
const { authMiddleware, requireRole } = require("../middlewares/auth");

const ALLOWED_SORT_FIELDS = ["course_name", "credit", "created_at"];
const CACHE_TTL_SECONDS = 60;
const CACHE_VERSION_KEY = "courses:cache:version";

async function getCacheVersion() {
  const version = await redisClient.get(CACHE_VERSION_KEY);
  if (version === null) {
    await redisClient.set(CACHE_VERSION_KEY, "1");
    return "1";
  }
  return version;
}

async function invalidateCourseCache() {
  // Versioned cache keys make invalidation work even when many
  // combinations of pagination/filter/sort exist.
  await redisClient.incr(CACHE_VERSION_KEY);

  // Keep this simple/base key clean too, in case an older cache entry exists.
  await redisClient.del("courses:list");
}

function parseListParams(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);

  const minCreditRaw = req.query.minCredit;
  const minCredit =
    minCreditRaw !== undefined && minCreditRaw !== ""
      ? Number(minCreditRaw)
      : null;

  const search =
    typeof req.query.search === "string" ? req.query.search.trim() : "";

  const sort = ALLOWED_SORT_FIELDS.includes(req.query.sort)
    ? req.query.sort
    : "id";

  const order =
    String(req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  return { page, limit, minCredit, search, sort, order };
}

function buildCourseQuery(params) {
  const { page, limit, minCredit, search, sort, order } = params;
  const where = [];
  const values = [];

  if (minCredit !== null && Number.isFinite(minCredit)) {
    where.push("credit >= ?");
    values.push(minCredit);
  }

  if (search) {
    where.push("course_name LIKE ?");
    values.push(`%${search}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // id is also explicitly safe because it is a fixed internal fallback,
  // while user-controlled sort fields are restricted by ALLOWED_SORT_FIELDS.
  const orderSql = `ORDER BY ${sort === "id" ? "id" : sort} ${order}`;

  const offset = (page - 1) * limit;

  return {
    dataSql: `SELECT id, course_name, credit, created_at
              FROM courses
              ${whereSql}
              ${orderSql}
              LIMIT ? OFFSET ?`,
    countSql: `SELECT COUNT(*) AS total FROM courses ${whereSql}`,
    dataValues: [...values, limit, offset],
    countValues: values,
  };
}

async function getCourses(req) {
  const params = parseListParams(req);
  const { dataSql, countSql, dataValues, countValues } =
    buildCourseQuery(params);

  const version = await getCacheVersion();
  const cacheKey = `courses:list:v${version}:${JSON.stringify({
    page: params.page,
    limit: params.limit,
    minCredit: params.minCredit,
    search: params.search,
    sort: params.sort,
    order: params.order,
  })}`;

  const cached = await redisClient.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // NOTE: pool.query() resolves to [rows, fields]. Inside Promise.all,
  // each resolved value keeps that same two-item shape, so the count
  // result must be destructured as [[countRows], [rows]] (one more
  // level than a single non-parallel query would need) — otherwise
  // `total` ends up undefined/NaN.
  const [[countRows], [rows]] = await Promise.all([
    pool.query(countSql, countValues),
    pool.query(dataSql, dataValues),
  ]);

  const totalNumber = Number(countRows[0].total);
  const result = {
    rows,
    pagination: {
      page: params.page,
      limit: params.limit,
      total: totalNumber,
      totalPages: Math.ceil(totalNumber / params.limit),
    },
    filter: {
      search: params.search || null,
      minCredit: params.minCredit,
    },
    sort: {
      field: params.sort,
      order: params.order,
    },
  };

  await redisClient.set(cacheKey, JSON.stringify(result), {
    EX: CACHE_TTL_SECONDS,
  });

  return result;
}

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  // JWT authentication is required for both API versions.
  v1Router.use(authMiddleware);
  v2Router.use(authMiddleware);

  // -------------------------
  // API v1: list courses
  // -------------------------
  v1Router.get("/courses", async (req, res, next) => {
    try {
      const result = await getCourses(req);

      res.status(200).json({
        message: "สำเร็จ",
        data: result.rows,
        meta: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------
  // API v1: create course
  // Only admin may write.
  // Multiple INSERTs are atomic through one transaction.
  // -------------------------
  v1Router.post("/courses", requireRole("admin"), async (req, res, next) => {
    let conn;

    const { course_name, credit, prerequisites = [] } = req.body;

    try {
      if (!course_name || !Number.isInteger(Number(credit))) {
        return res.status(400).json({
          message: "ข้อมูล course ไม่ถูกต้อง",
        });
      }

      if (!Array.isArray(prerequisites)) {
        return res.status(400).json({
          message: "prerequisites ต้องเป็น array",
        });
      }

      conn = await pool.getConnection();
      await conn.beginTransaction();

      const [result] = await conn.query(
        "INSERT INTO courses (course_name, credit) VALUES (?, ?)",
        [course_name, Number(credit)],
      );

      const courseId = result.insertId;

      for (const prereqId of prerequisites) {
        await conn.query(
          "INSERT INTO course_prerequisites (course_id, prereq_course_id) VALUES (?, ?)",
          [courseId, prereqId],
        );
      }

      await conn.commit();
      await invalidateCourseCache();

      return res.status(201).json({
        message: "เพิ่มข้อมูลสำเร็จ",
        data: { id: courseId },
      });
    } catch (err) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (_) {}
      }
      return next(err);
    } finally {
      if (conn) conn.release();
    }
  });

  // -------------------------
  // API v2: same resource, different response structure
  // -------------------------
  v2Router.get("/courses", async (req, res, next) => {
    try {
      const result = await getCourses(req);

      res.status(200).json({
        success: true,
        result: {
          items: result.rows,
          pagination: result.pagination,
          query: {
            search: result.filter.search,
            minCredit: result.filter.minCredit,
            sort: result.sort.field,
            order: result.sort.order,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  v2Router.post("/courses", requireRole("admin"), async (req, res, next) => {
    let conn;

    const { course_name, credit, prerequisites = [] } = req.body;

    try {
      if (!course_name || !Number.isInteger(Number(credit))) {
        return res.status(400).json({
          success: false,
          error: "ข้อมูล course ไม่ถูกต้อง",
        });
      }

      if (!Array.isArray(prerequisites)) {
        return res.status(400).json({
          success: false,
          error: "prerequisites ต้องเป็น array",
        });
      }

      conn = await pool.getConnection();
      await conn.beginTransaction();

      const [result] = await conn.query(
        "INSERT INTO courses (course_name, credit) VALUES (?, ?)",
        [course_name, Number(credit)],
      );

      const courseId = result.insertId;

      for (const prereqId of prerequisites) {
        await conn.query(
          "INSERT INTO course_prerequisites (course_id, prereq_course_id) VALUES (?, ?)",
          [courseId, prereqId],
        );
      }

      await conn.commit();
      await invalidateCourseCache();

      return res.status(201).json({
        success: true,
        course: { id: courseId },
      });
    } catch (err) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (_) {}
      }
      return next(err);
    } finally {
      if (conn) conn.release();
    }
  });

  registerCourseRoutes.ALLOWED_SORT_FIELDS = ALLOWED_SORT_FIELDS;
};
