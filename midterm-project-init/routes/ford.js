const { pool } = require("../db");
const { redisClient } = require("../cache");

const ALLOWED_SORT_FIELDS = ["course_name", "credit", "created_at"];

// EX1 รับฟังก์ชัน JWT Auth / RBAC (wk06)
const { authMiddleware, requireRole } = require("../middlewares/auth");
// EX2 รับฟังก์ชัน Pagination / Filtering / Sorting (wk07)
const { parsePagination, parseSort } = require("../middlewares/query-parser");

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  v1Router.get(
    "/courses",
    // EX1 JWT Auth: ยืนยันตัวตน
    authMiddleware,
    // EX1 RBAC: กำหนดบทบาทที่มีสิทธิ์
    requireRole("admin"),
    async (req, res, next) => {
      // EX1 Caching: บันทึกข้อมูลเก็บไว้เพื่อเรียกใช้ได้ในทันที
      const cacheKey = "courses:all";

      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          return res.status(200).json({
            message: "สำเร็จ (จาก cache)",
            data: JSON.parse(cached),
          });
        }

        const [rows] = await pool.query("SELECT * FROM courses ORDER BY id");
        // Caching: กำหนดเวลาที่เก็บข้อมูลในหน่วยความจำ
        await redisClient.set(cacheKey, JSON.stringify(rows), { EX: 60 });

        res.status(200).json({ message: "สำเร็จ (จากฐานข้อมูล)", data: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  // EX1 GET: เฉพาะผู้ที่ล็อกอินแล้วเท่านั้นที่ดูข้อมูลของตนเองได้
  v1Router.get("/auth/me", authMiddleware, (req, res) => {
    res.status(200).json({ message: "สำเร็จ", data: req.user });
  });

  // EX2 GET: ดึงข้อมูลรายวิชาพร้อมกรองข้อมูลตามที่ระบุ ?name=..&..
  // Sample: http://localhost:3000/api/v1/courses?page=1&limit=2&sort=name&order=desc
  v1Router.get(
    "/courses/pagination",
    parsePagination,
    parseSort,
    async (req, res, next) => {
      const { course_name } = req.query;
      const { page, limit, offset } = req.pagination;
      const { field, order } = req.sort;

      let baseQuery = "SELECT * FROM courses";
      let countQuery = "SELECT COUNT(*) AS total FROM courses";
      const params = [];

      if (course_name) {
        baseQuery += " WHERE course_name = ?";
        countQuery += " WHERE course_name = ?";
        params.push(course_name);
      }

      // แทรก field/order ลง SQL ได้โดยตรงเฉพาะเพราะผ่าน allowlist ใน parseSort มาแล้ว
      // ห้ามนำรูปแบบนี้ไปใช้กับค่าจาก req อื่นที่ไม่ได้ผ่าน allowlist
      baseQuery += ` ORDER BY ${field} ${order} LIMIT ? OFFSET ?`;

      try {
        const [rows] = await pool.query(baseQuery, [...params, limit, offset]);
        const [[{ total }]] = await pool.query(countQuery, params);

        res.status(200).json({
          message: "สำเร็จ",
          data: rows,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // EX04 API Versioning: สร้าง Router ใหม่ที่แตกต่างจากเดิม (wk07)
  v2Router.get("/courses", async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT * FROM courses");
      // v2 ปรับโครงสร้างผลลัพธ์ใหม่ ไม่มี wrapper "message" เหมือน v1
      res.status(200).json({ items: rows, count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  // EX03 Transaction: เพิ่มรายวิชาใหม่ โดยมีการรักษาความถูกต้องของข้อมูล (wk05)
  v1Router.post("/courses", async (req, res, next) => {
    const { course_name, credit, prerequisites = [] } = req.body;
    const connection = await pool.getConnection();

    try {
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

      const [result] = await connection.query(
        "INSERT INTO courses (course_name, credit) VALUES (?, ?)",
        [course_name, credit],
      );

      // EX1 Caching: ล้างแคชเนื่องจากข้อมูลเปลี่ยนแปลงแล้ว
      await redisClient.del("courses:all");

      const courseId = result.insertId;
      for (const prereqId of prerequisites) {
        await connection.query(
          "INSERT INTO course_prerequisites (course_id, prereq_course_id) VALUES (?, ?)",
          [courseId, prereqId],
        );
      }
      await connection.commit();
      res
        .status(201)
        .json({ message: "เพิ่มข้อมูลสำเร็จ", data: { id: courseId } });
    } catch (err) {
      await connection.rollback();
      next(err);
    }
  });

  registerCourseRoutes.ALLOWED_SORT_FIELDS = ALLOWED_SORT_FIELDS;
};
