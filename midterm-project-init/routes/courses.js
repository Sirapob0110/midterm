const { pool } = require("../db");
const { redisClient } = require("../cache");
const { authMiddleware, requireRole } = require("../middlewares/auth");

const ALLOWED_SORT_FIELDS = ["id", "course_name", "credit", "created_at"];
const CACHE_TTL_SECONDS = 120;

// Helper & Middleware
function parseQuery(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);

  const courseName =
    req.query.course_name !== undefined && req.query.course_name !== ""
      ? String(req.query.course_name)
      : null;

  const minCredit =
    req.query.minCredit !== undefined && req.query.minCredit !== ""
      ? Number(req.query.minCredit)
      : null;

  const sort = ALLOWED_SORT_FIELDS.includes(req.query.sort)
    ? req.query.sort
    : "id";

  const order =
    String(req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

  return {
    page,
    limit,
    offset: (page - 1) * limit,
    courseName,
    minCredit,
    sort,
    order,
  };
}

function buildCacheKey(query) {
  return [
    "courses:list",
    `page=${query.page}`,
    `limit=${query.limit}`,
    `course_name=${query.courseName ?? ""}`,
    `minCredit=${query.minCredit ?? ""}`,
    `sort=${query.sort}`,
    `order=${query.order}`,
  ].join(":");
}

async function clearCourseCache() {
  let cursor = "0";

  do {
    const reply = await redisClient.scan(cursor, {
      MATCH: "courses:list:*",
      COUNT: 100,
    });

    cursor = reply.cursor;

    const keys = reply.keys;

    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } while (cursor !== "0");
}

function deprecationWarning(req, res, next) {
  res.set("Deprecation", "@1767225600");
  res.set("Link", '</api/v2/courses>; rel="successor-version"');
  next();
}

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  // JWT Authentication
  v1Router.use(authMiddleware);
  v2Router.use(authMiddleware);

  // Auth Me
  v1Router.get("/auth/me", (req, res) => {
    let user;

    if (req.user.sub === "u-admin") {
      user = {
        id: 1,
        username: "admin",
        role: "admin",
      };
    } else if (req.user.sub === "u-student") {
      user = {
        id: 2,
        username: "student",
        role: "student",
      };
    } else {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "ไม่พบข้อมูลผู้ใช้งาน",
        },
      });
    }

    return res.status(200).json({
      message: "เข้าสู่ระบบสำเร็จ",
      data: user,
    });
  });

  // v1 Deprecation
  v1Router.use("/courses", deprecationWarning);

  // =========================================================
  // V1 GET /courses
  // Admin only
  // Pagination + Search + Filter + Sort + Cache
  // =========================================================
  v1Router.get("/courses", requireRole("admin"), async (req, res, next) => {
    const query = parseQuery(req);
    const cacheKey = buildCacheKey(query);

    try {
      // Check cache
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        const parsed = JSON.parse(cached);

        return res.status(200).json({
          message: "สำเร็จ (จาก cache)",
          data: parsed.rows,
          pagination: parsed.pagination,
        });
      }

      // Build conditions
      const conditions = [];
      const params = [];

      // Search course name
      if (query.courseName) {
        conditions.push("course_name LIKE ?");
        params.push(`%${query.courseName}%`);
      }

      // Filter minimum credit
      if (Number.isFinite(query.minCredit)) {
        conditions.push("credit >= ?");
        params.push(query.minCredit);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      // Count total
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM courses
         ${where}`,
        params,
      );

      const total = countRows[0].total;
      const totalPages = Math.ceil(total / query.limit);

      // Get courses
      const [rows] = await pool.query(
        `SELECT id, course_name, credit, created_at
         FROM courses
         ${where}
         ORDER BY ${query.sort} ${query.order}
         LIMIT ? OFFSET ?`,
        [...params, query.limit, query.offset],
      );

      const payload = {
        rows,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
        },
      };

      // Save cache
      await redisClient.set(cacheKey, JSON.stringify(payload), {
        EX: CACHE_TTL_SECONDS,
      });

      return res.status(200).json({
        message: "สำเร็จ (จากฐานข้อมูล)",
        data: rows,
        pagination: payload.pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================
  // V1 POST /courses
  // Admin only
  // Transaction
  // =========================================================
  v1Router.post("/courses", requireRole("admin"), async (req, res, next) => {
    const { course_name, credit, prerequisites = [] } = req.body;

    // Validation
    if (
      !course_name ||
      !Number.isInteger(Number(credit)) ||
      Number(credit) <= 0
    ) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "course_name ต้องมีค่า และ credit ต้องเป็นจำนวนเต็มที่มากกว่า 0",
        },
      });
    }

    if (!Array.isArray(prerequisites)) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "prerequisites ต้องเป็น array",
        },
      });
    }

    let conn;

    try {
      conn = await pool.getConnection();

      // Check prerequisite courses
      if (prerequisites.length > 0) {
        const placeholders = prerequisites.map(() => "?").join(",");

        const [existingCourses] = await conn.query(
          `SELECT id
           FROM courses
           WHERE id IN (${placeholders})`,
          prerequisites,
        );

        if (existingCourses.length !== prerequisites.length) {
          return res.status(400).json({
            error: {
              code: "VALIDATION_ERROR",
              message: "พบ prerequisites ที่ไม่มีอยู่ในระบบ",
            },
          });
        }
      }

      // Start transaction
      await conn.beginTransaction();

      // Insert course
      const [result] = await conn.query(
        `INSERT INTO courses (course_name, credit)
         VALUES (?, ?)`,
        [course_name, Number(credit)],
      );

      const courseId = result.insertId;

      // Insert prerequisites
      for (const prereqId of prerequisites) {
        await conn.query(
          `INSERT INTO course_prerequisites
           (course_id, prereq_course_id)
           VALUES (?, ?)`,
          [courseId, prereqId],
        );
      }

      // Commit
      await conn.commit();

      // Clear Redis cache
      await clearCourseCache();

      return res.status(201).json({
        message: "เพิ่มข้อมูลสำเร็จ",
        data: {
          id: courseId,
          course_name,
          credit: Number(credit),
          prerequisites,
        },
      });
    } catch (err) {
      // Rollback
      if (conn) {
        try {
          await conn.rollback();
        } catch (_) {}
      }

      next(err);
    } finally {
      // Release connection
      if (conn) {
        conn.release();
      }
    }
  });

  // =========================================================
  // V2 GET /courses
  // Different response structure
  // Pagination + Search + Filter + Sort + Cache
  // =========================================================
  v2Router.get("/courses", async (req, res, next) => {
    const query = parseQuery(req);
    const cacheKey = buildCacheKey(query);

    try {
      // Check cache
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        const parsed = JSON.parse(cached);

        return res.status(200).json({
          items: parsed.rows,
          count: parsed.rows.length,
          pagination: parsed.pagination,
        });
      }

      // Build conditions
      const conditions = [];
      const params = [];

      // Search course name
      if (query.courseName) {
        conditions.push("course_name LIKE ?");
        params.push(`%${query.courseName}%`);
      }

      // Filter minimum credit
      if (Number.isFinite(query.minCredit)) {
        conditions.push("credit >= ?");
        params.push(query.minCredit);
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      // Count total
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM courses
         ${where}`,
        params,
      );

      const total = countRows[0].total;
      const totalPages = Math.ceil(total / query.limit);

      // Get courses
      const [rows] = await pool.query(
        `SELECT id, course_name, credit, created_at
         FROM courses
         ${where}
         ORDER BY ${query.sort} ${query.order}
         LIMIT ? OFFSET ?`,
        [...params, query.limit, query.offset],
      );

      const payload = {
        rows,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
        },
      };

      // Save cache
      await redisClient.set(cacheKey, JSON.stringify(payload), {
        EX: CACHE_TTL_SECONDS,
      });

      return res.status(200).json({
        items: rows,
        count: rows.length,
        pagination: payload.pagination,
      });
    } catch (err) {
      next(err);
    }
  });
};
