const { pool } = require("../db");
const { redisClient } = require("../cache");
const { authMiddleware, requireRole } = require("../middlewares/auth");

// Week 7: sort field ต้องผ่าน allowlist ก่อนนำไปต่อ SQL
const ALLOWED_SORT_FIELDS = [
  "id",
  "course_name",
  "credit",
  "created_at",
];

const CACHE_TTL_SECONDS = 60;

function parseQuery(req) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 10, 1),
    100,
  );

  const minCredit =
    req.query.minCredit !== undefined && req.query.minCredit !== ""
      ? Number(req.query.minCredit)
      : null;

  // ถ้า sort ไม่อยู่ใน allowlist ให้ใช้ id เป็นค่า default
  const sort = ALLOWED_SORT_FIELDS.includes(req.query.sort)
    ? req.query.sort
    : "id";

  const order =
    String(req.query.order || "asc").toLowerCase() === "desc"
      ? "DESC"
      : "ASC";

  return {
    page,
    limit,
    offset: (page - 1) * limit,
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
    `minCredit=${query.minCredit ?? ""}`,
    `sort=${query.sort}`,
    `order=${query.order}`,
  ].join(":");
}

async function clearCourseCache() {
  // ลบ cache ของ courses ทุกชุด เพราะ POST ทำให้ผลลัพธ์ของหลาย query เปลี่ยนได้
  const keys = await redisClient.keys("courses:list:*");

  if (keys.length > 0) {
    await redisClient.del(keys);
  }
}

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  // Week 6: ทุก route ต้องผ่าน JWT ก่อน
  v1Router.use(authMiddleware);
  v2Router.use(authMiddleware);

  // =====================================================
  // GET /api/v1/courses
  // Pagination + Filtering + Sorting + Redis Cache
  // =====================================================
  v1Router.get("/courses", async (req, res, next) => {
    try {
      const query = parseQuery(req);
      const cacheKey = buildCacheKey(query);

      // Cache hit
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        const result = JSON.parse(cached);

        return res.status(200).json({
          message: "สำเร็จ (จาก cache)",
          data: result.rows,
          pagination: result.pagination,
        });
      }

      // Cache miss -> query จากฐานข้อมูลจริง
      let whereSql = "";
      const params = [];

      if (query.minCredit !== null && Number.isFinite(query.minCredit)) {
        whereSql = " WHERE credit >= ?";
        params.push(query.minCredit);
      }

      const dataSql = `
        SELECT *
        FROM courses
        ${whereSql}
        ORDER BY ${query.sort} ${query.order}
        LIMIT ? OFFSET ?
      `;

      const countSql = `
        SELECT COUNT(*) AS total
        FROM courses
        ${whereSql}
      `;

      const [rowsResult, countResult] = await Promise.all([
        pool.query(dataSql, [...params, query.limit, query.offset]),
        pool.query(countSql, params),
      ]);

      const rows = rowsResult[0];
      const total = Number(countResult[0][0].total);

      const result = {
        rows,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      };

      // เก็บผลลัพธ์ไว้ใน Redis 60 วินาที
      await redisClient.set(cacheKey, JSON.stringify(result), {
        EX: CACHE_TTL_SECONDS,
      });

      return res.status(200).json({
        message: "สำเร็จ (จากฐานข้อมูล)",
        data: rows,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  });

  // =====================================================
  // POST /api/v1/courses
  // Admin only + Transaction
  // =====================================================
  v1Router.post(
    "/courses",
    requireRole("admin"),
    async (req, res, next) => {
      let connection;

      const {
        course_name,
        credit,
        prerequisites = [],
      } = req.body;

      // Validation แบบเดียวกับแนว Lab
      if (!course_name || credit === undefined) {
        return res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "กรุณาระบุ course_name และ credit",
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

      try {
        connection = await pool.getConnection();

        // Week 5: Transaction
        await connection.beginTransaction();

        const [result] = await connection.query(
          `
          INSERT INTO courses (course_name, credit)
          VALUES (?, ?)
          `,
          [course_name, credit],
        );

        const courseId = result.insertId;

        // เพิ่ม prerequisite ใน transaction เดียวกัน
        for (const prereqId of prerequisites) {
          await connection.query(
            `
            INSERT INTO course_prerequisites
              (course_id, prereq_course_id)
            VALUES (?, ?)
            `,
            [courseId, prereqId],
          );
        }

        // สำเร็จทุกคำสั่ง -> commit
        await connection.commit();

        // ข้อมูลเปลี่ยน -> ล้าง cache courses
        await clearCourseCache();

        // Week 3/5: คืนค่าข้อมูลที่เพิ่งสร้าง ไม่ใช่แค่ id
        return res.status(201).json({
          message: "เพิ่มข้อมูลสำเร็จ",
          data: {
            id: courseId,
            course_name,
            credit,
            prerequisites,
          },
        });
      } catch (err) {
        // ถ้ามีคำสั่งใดพัง -> rollback ทั้งชุด
        if (connection) {
          try {
            await connection.rollback();
          } catch (_) {}
        }

        next(err);
      } finally {
        if (connection) {
          connection.release();
        }
      }
    },
  );

  // =====================================================
  // GET /api/v2/courses
  // Version ใหม่ -> response structure ต่างจาก v1
  // =====================================================
  v2Router.get("/courses", async (req, res, next) => {
    try {
      const query = parseQuery(req);
      const cacheKey = buildCacheKey(query);

      const cached = await redisClient.get(cacheKey);

      let result;

      if (cached) {
        result = JSON.parse(cached);
      } else {
        let whereSql = "";
        const params = [];

        if (query.minCredit !== null && Number.isFinite(query.minCredit)) {
          whereSql = " WHERE credit >= ?";
          params.push(query.minCredit);
        }

        const dataSql = `
          SELECT *
          FROM courses
          ${whereSql}
          ORDER BY ${query.sort} ${query.order}
          LIMIT ? OFFSET ?
        `;

        const countSql = `
          SELECT COUNT(*) AS total
          FROM courses
          ${whereSql}
        `;

        const [rowsResult, countResult] = await Promise.all([
          pool.query(dataSql, [...params, query.limit, query.offset]),
          pool.query(countSql, params),
        ]);

        const rows = rowsResult[0];
        const total = Number(countResult[0][0].total);

        result = {
          rows,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        };

        await redisClient.set(cacheKey, JSON.stringify(result), {
          EX: CACHE_TTL_SECONDS,
        });
      }

      // v2 ไม่มี message wrapper แบบ v1
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
