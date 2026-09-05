const { pool } = require("../db");
const { redisClient } = require("../cache");
const { authMiddleware, requireRole } = require("../middlewares/auth");

const ALLOWED_SORT_FIELDS = ["id", "course_name", "credit", "created_at"];
const CACHE_TTL_SECONDS = 120; // รายวิชาไม่ค่อยเปลี่ยน ตั้ง TTL ให้นานกว่าปกติได้ (W7)

// =========================
// Helper & Middleware
// =========================

function parseQuery(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);

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
    minCredit,
    sort,
    order,
  };
}

// [Week 7]: ออกแบบ Cache Key ที่รวมพารามิเตอร์การค้นหา
function buildCacheKey(query) {
  return [
    "courses:list",
    `page=${query.page}`,
    `limit=${query.limit}`,
    `minCredit=${query.minCredit ?? ""}`,
    `sort=${query.sort}`,
    `order=${query.order}`,
  ].join(":");
}

// ใช้ SCAN แทน KEYS เพื่อป้องกัน Redis ค้างเมื่อข้อมูลมีขนาดใหญ่
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

// [Week 7]: Middleware ตรวจสอบ Header Deprecation สำหรับ V1
function deprecationWarning(req, res, next) {
  res.set("Deprecation", "@1767225600");
  res.set("Link", '</api/v2/courses>; rel="successor-version"');
  next();
}

// =========================
// Routes
// =========================

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  // ทุก endpoint ต้องมี JWT
  v1Router.use(authMiddleware);
  v2Router.use(authMiddleware);

  // นำ Deprecation middleware ไปใช้เฉพาะกับ v1Router
  v1Router.use("/courses", deprecationWarning);

  // =========================================
  // V1 - GET Courses
  // Student / Admin ทำได้
  // =========================================

  v1Router.get("/courses", async (req, res, next) => {
    try {
      const query = parseQuery(req);
      const cacheKey = buildCacheKey(query);

      // ---------- Cache ----------
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        const result = JSON.parse(cached);
        return res.status(200).json({
          message: "สำเร็จ (จาก cache)",
          data: result.rows,
          pagination: result.pagination,
        });
      }

      // ---------- Database ----------
      let where = "";
      const params = [];

      if (query.minCredit !== null && Number.isFinite(query.minCredit)) {
        where = "WHERE credit >= ?";
        params.push(query.minCredit);
      }

      const [rows] = await pool.query(
        `
        SELECT *
        FROM courses
        ${where}
        ORDER BY ${query.sort} ${query.order}
        LIMIT ? OFFSET ?
        `,
        [...params, query.limit, query.offset],
      );

      const [countRows] = await pool.query(
        `
        SELECT COUNT(*) AS total
        FROM courses
        ${where}
        `,
        params,
      );

      const total = countRows[0].total;
      const totalPages = Math.ceil(total / query.limit);

      const pagination = {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
      };

      const result = { rows, pagination };

      // ---------- Save Cache ----------
      await redisClient.set(cacheKey, JSON.stringify(result), {
        EX: CACHE_TTL_SECONDS,
      });

      return res.status(200).json({
        message: "สำเร็จ (จากฐานข้อมูล)",
        data: rows,
        pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  // =========================================
  // V1 - POST Courses
  // เฉพาะ Admin
  // =========================================

  v1Router.post("/courses", requireRole("admin"), async (req, res, next) => {
    const { course_name, credit, prerequisites = [] } = req.body;

    // ---------- Validation ----------
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

    let connection;

    try {
      connection = await pool.getConnection();

      // เช็คว่ารหัสวิชาใน prerequisites มีอยู่จริงใน Database หรือไม่
      if (prerequisites.length > 0) {
        const placeholders = prerequisites.map(() => "?").join(",");
        const [existingCourses] = await connection.query(
          `SELECT id FROM courses WHERE id IN (${placeholders})`,
          prerequisites,
        );

        if (existingCourses.length !== prerequisites.length) {
          // ปล่อยให้ finally จัดการ release connection
          return res.status(400).json({
            error: {
              code: "VALIDATION_ERROR",
              message: "รหัสวิชา prerequisite บางตัวไม่มีอยู่ในระบบ",
            },
          });
        }
      }

      // ---------- Transaction ----------
      await connection.beginTransaction();

      const [result] = await connection.query(
        `
          INSERT INTO courses (course_name, credit)
          VALUES (?, ?)
          `,
        [course_name, Number(credit)],
      );

      const courseId = result.insertId;

      // ---------- Insert Prerequisites ----------
      for (const prereqId of prerequisites) {
        await connection.query(
          `
            INSERT INTO course_prerequisites (course_id, prereq_course_id)
            VALUES (?, ?)
            `,
          [courseId, prereqId],
        );
      }

      await connection.commit();

      // ---------- Clear Cache ----------
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
      if (connection) {
        // ห่อ try/catch ป้องกัน rollback() throw error แล้วหลุดจาก middleware
        try {
          await connection.rollback();
        } catch (rollbackErr) {
          console.error("Rollback failed:", rollbackErr);
        }
      }
      next(err);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  });

  // =========================================
  // V2 - GET Courses
  // Student / Admin ทำได้
  // =========================================

  v2Router.get("/courses", async (req, res, next) => {
    try {
      const query = parseQuery(req);
      const cacheKey = buildCacheKey(query);

      const cached = await redisClient.get(cacheKey);

      let result;

      if (cached) {
        result = JSON.parse(cached);
      } else {
        let where = "";
        const params = [];

        if (query.minCredit !== null && Number.isFinite(query.minCredit)) {
          where = "WHERE credit >= ?";
          params.push(query.minCredit);
        }

        const [rows] = await pool.query(
          `
          SELECT *
          FROM courses
          ${where}
          ORDER BY ${query.sort} ${query.order}
          LIMIT ? OFFSET ?
          `,
          [...params, query.limit, query.offset],
        );

        const [countRows] = await pool.query(
          `
          SELECT COUNT(*) AS total
          FROM courses
          ${where}
          `,
          params,
        );

        const total = countRows[0].total;
        const totalPages = Math.ceil(total / query.limit);

        result = {
          rows,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages,
          },
        };

        await redisClient.set(cacheKey, JSON.stringify(result), {
          EX: CACHE_TTL_SECONDS,
        });
      }

      // V2 โครงสร้าง Response ต่างจาก V1
      return res.status(200).json({
        items: result.rows,
        count: result.rows.length,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  registerCourseRoutes.ALLOWED_SORT_FIELDS = ALLOWED_SORT_FIELDS;
};
