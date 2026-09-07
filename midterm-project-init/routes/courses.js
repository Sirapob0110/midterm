const { pool } = require("../db");
const { redisClient } = require("../cache");

const ALLOWED_SORT_FIELDS = ["id", "course_name", "credit", "created_at"];

// JWT / RBAC
const { authMiddleware, requireRole } = require("../middlewares/auth");

// Pagination / Filtering / Sorting
function parsePagination(req, res, next) {
  req.pagination = {
    page: Math.max(1, parseInt(req.query.page) || 1),
    limit: Math.min(100, parseInt(req.query.limit) || 10),
  };

  req.pagination.offset = (req.pagination.page - 1) * req.pagination.limit;

  next();
}

function parseSort(req, res, next) {
  req.sort = {
    field: ALLOWED_SORT_FIELDS.includes(req.query.sort) ? req.query.sort : "id",
    order: req.query.order === "desc" ? "DESC" : "ASC",
  };

  next();
}

function buildCacheKey(req) {
  const { page, limit, minCredit, course_name, sort, order } = req.query;

  return `courses:${page || 1}:${limit || 10}:${minCredit || ""}:${
    course_name || ""
  }:${sort || "id"}:${order || "asc"}`;
}

async function clearCourseCache() {
  const keys = await redisClient.keys("courses:*");

  if (keys.length > 0) {
    await redisClient.del(keys);
  }
}

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  // ทุก endpoint ของ router ต้องผ่าน JWT
  v1Router.use(authMiddleware);
  v2Router.use(authMiddleware);

  // =========================
  // AUTH ME
  // =========================
  v1Router.get("/auth/me", (req, res) => {
    res.status(200).json({
      message: "สำเร็จ",
      data: req.user,
    });
  });

  // =========================
  // V1 GET COURSES
  // =========================
  v1Router.get(
    "/courses",
    requireRole("admin"),
    parsePagination,
    parseSort,
    async (req, res, next) => {
      const { page, limit, offset } = req.pagination;
      const { field, order } = req.sort;

      const { minCredit, course_name } = req.query;

      const cacheKey = buildCacheKey(req);

      try {
        // Cache-aside
        const cached = await redisClient.get(cacheKey);

        if (cached) {
          return res.status(200).json({
            message: "สำเร็จ (จาก cache)",
            data: JSON.parse(cached),
          });
        }

        let baseQuery = "SELECT * FROM courses";
        let countQuery = "SELECT COUNT(*) AS total FROM courses";

        const params = [];
        const countParams = [];

        const conditions = [];

        if (minCredit) {
          conditions.push("credit >= ?");
          params.push(minCredit);
          countParams.push(minCredit);
        }

        if (course_name) {
          conditions.push("course_name LIKE ?");
          params.push(`%${course_name}%`);
          countParams.push(`%${course_name}%`);
        }

        if (conditions.length > 0) {
          baseQuery += " WHERE " + conditions.join(" AND ");
          countQuery += " WHERE " + conditions.join(" AND ");
        }

        // sort ใช้ค่าที่ผ่าน allowlist แล้ว
        baseQuery += ` ORDER BY ${field} ${order} LIMIT ? OFFSET ?`;

        const [rows] = await pool.query(baseQuery, [...params, limit, offset]);

        const [[{ total }]] = await pool.query(countQuery, countParams);

        const result = {
          rows,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        };

        // เก็บ cache
        await redisClient.set(cacheKey, JSON.stringify(result), { EX: 60 });

        res.status(200).json({
          message: "สำเร็จ (จากฐานข้อมูล)",
          data: result,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================
  // V1 POST COURSE
  // =========================
  v1Router.post("/courses", requireRole("admin"), async (req, res, next) => {
    const { course_name, credit, prerequisites = [] } = req.body;

    const connection = await pool.getConnection();

    try {
      // Transaction
      await connection.beginTransaction();

      if (!course_name || !credit) {
        await connection.rollback();

        return res.status(400).json({
          error: {
            code: "BAD_REQUEST",
            message: "ใส่ข้อมูลไม่ครบถ้วน (course_name, credit)",
          },
        });
      }

      // เพิ่ม course
      const [result] = await connection.query(
        "INSERT INTO courses (course_name, credit) VALUES (?, ?)",
        [course_name, credit],
      );

      const courseId = result.insertId;

      // เพิ่ม prerequisite
      for (const prereqId of prerequisites) {
        await connection.query(
          `INSERT INTO course_prerequisites
            (course_id, prereq_course_id)
            VALUES (?, ?)`,
          [courseId, prereqId],
        );
      }

      // ทุกอย่างสำเร็จค่อย commit
      await connection.commit();

      // ลบ cache หลัง commit
      await clearCourseCache();

      res.status(201).json({
        message: "เพิ่มข้อมูลสำเร็จ",
        data: {
          id: courseId,
        },
      });
    } catch (err) {
      // ถ้า error ให้ rollback
      await connection.rollback();
      next(err);
    } finally {
      // คืน connection ให้ pool
      connection.release();
    }
  });

  // =========================
  // V2 GET COURSES
  // =========================
  v2Router.get(
    "/courses",
    requireRole("admin"),
    parsePagination,
    parseSort,
    async (req, res, next) => {
      const { page, limit, offset } = req.pagination;
      const { field, order } = req.sort;

      const { minCredit, course_name } = req.query;

      const cacheKey = `v2:${buildCacheKey(req)}`;

      try {
        const cached = await redisClient.get(cacheKey);

        if (cached) {
          return res.status(200).json(JSON.parse(cached));
        }

        let baseQuery = "SELECT * FROM courses";
        let countQuery = "SELECT COUNT(*) AS total FROM courses";

        const params = [];
        const countParams = [];

        const conditions = [];

        if (minCredit) {
          conditions.push("credit >= ?");
          params.push(minCredit);
          countParams.push(minCredit);
        }

        if (course_name) {
          conditions.push("course_name LIKE ?");
          params.push(`%${course_name}%`);
          countParams.push(`%${course_name}%`);
        }

        if (conditions.length > 0) {
          baseQuery += " WHERE " + conditions.join(" AND ");
          countQuery += " WHERE " + conditions.join(" AND ");
        }

        baseQuery += ` ORDER BY ${field} ${order} LIMIT ? OFFSET ?`;

        const [rows] = await pool.query(baseQuery, [...params, limit, offset]);

        const [[{ total }]] = await pool.query(countQuery, countParams);

        // V2 response คนละ structure กับ V1
        const result = {
          items: rows,
          meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        };

        await redisClient.set(cacheKey, JSON.stringify(result), { EX: 60 });

        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  registerCourseRoutes.ALLOWED_SORT_FIELDS = ALLOWED_SORT_FIELDS;
};
