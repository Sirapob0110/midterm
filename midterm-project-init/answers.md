# answers.md

## 1. SQL Injection กับ allowlist

ค่าที่ใช้เป็น SQL parameter เช่น `search`, `minCredit` และค่าจาก request body ควรส่งผ่าน `?` และ parameter array ของ MySQL ไม่ควรนำ string จากผู้ใช้มาต่อเข้า SQL โดยตรง

กรณี `ORDER BY` ไม่สามารถใช้ `?` แทนชื่อ column ได้ จึงต้องใช้ allowlist เช่น `ALLOWED_SORT_FIELDS` เพื่อตรวจว่าชื่อ column ที่ผู้ใช้ส่งมาอยู่ในรายการที่อนุญาตก่อนนำไปประกอบ SQL ส่วน `ASC/DESC` ก็ตรวจให้เหลือเฉพาะค่าที่กำหนดไว้

ดังนั้น parameterized query ป้องกัน injection ใน “ค่า” ส่วน allowlist ป้องกัน injection ในส่วนที่เป็น SQL identifier เช่นชื่อ column และทิศทางการ sort

## 2. ความสำคัญของ Transaction

การเพิ่ม course และการเพิ่ม prerequisite เป็นงานที่เกี่ยวข้องกันหลายคำสั่ง หาก INSERT ตาราง `courses` สำเร็จ แต่ INSERT `course_prerequisites` ล้มเหลว จะเกิดข้อมูลค้างและฐานข้อมูลไม่อยู่ในสถานะที่ต้องการ

Transaction ทำให้ชุดคำสั่งเป็น atomic:

- สำเร็จทั้งหมด -> `COMMIT`
- มีคำสั่งใดล้มเหลว -> `ROLLBACK`

จึงช่วยรักษาความสอดคล้องของข้อมูลและป้องกัน partial update

## 3. In-memory cache กับ Multi-instance deployment

In-memory cache เช่น object หรือ Map ที่อยู่ใน Node.js process จะถูกแยกกันในแต่ละ instance

ตัวอย่างเช่นมี server 2 ตัว:

- Instance A มีข้อมูล cache ใหม่
- Instance B อาจยังมีข้อมูลเก่า

เมื่อ request ถูก load balance ไปคนละ instance ผลลัพธ์จึงอาจไม่เหมือนกัน และการ invalidation ที่ instance เดียวจะไม่ล้าง cache ของ instance อื่น

Redis เหมาะกับกรณีนี้มากกว่า เพราะเป็น shared external cache ที่ทุก instance ใช้ข้อมูลชุดเดียวกันได้

## 4. การจัดการ API Deprecation

ไม่ควรถอด API เก่าทันที ควรมีช่วงเปลี่ยนผ่าน เช่น:

1. ประกาศว่า v1 จะ deprecated และแจ้งกำหนดวันเลิกใช้งาน
2. แนะนำ endpoint หรือ API version ใหม่ เช่น v2
3. เอกสารต้องระบุความแตกต่างและวิธี migrate
4. หากเหมาะสมอาจส่ง header เช่น `Deprecation` หรือ `Sunset` เพื่อแจ้ง client
5. เก็บสถิติการใช้งาน v1 เพื่อตรวจว่ามี client สำคัญเหลืออยู่หรือไม่
6. เมื่อครบกำหนดจึงหยุดรองรับ v1 อย่างเป็นทางการ

แนวทางนี้ช่วยให้ผู้ใช้ API มีเวลาปรับระบบและลดความเสี่ยงจากการเปลี่ยน API แบบทันที
