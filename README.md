# Midterm Project — Setup Notes

บันทึกคำสั่งที่ใช้ระหว่างตั้งค่าโปรเจกต์ และปัญหาที่เจอพร้อมวิธีแก้ (เรียงตามลำดับที่เกิดจริง)

## 1. เปิด Docker (MySQL + Redis)

```bash
cd midterm-project-init   # ต้องอยู่โฟลเดอร์ที่มี docker-compose.yml
docker compose up -d
```

**ปัญหาที่เจอ:** `no configuration file provided: not found`
**สาเหตุ:** รันคำสั่งผิดโฟลเดอร์ (อยู่นอกโฟลเดอร์ที่มี `docker-compose.yml`)
**แก้:** `cd` เข้าโฟลเดอร์ที่ถูกต้องก่อนรันคำสั่ง

## 2. ติดตั้ง dependencies

```bash
npm install
```

**ปัญหาที่เจอ:** `Error: Cannot find module 'redis'`
**สาเหตุ:** ไฟล์ zip ที่แจกมาไม่มี `node_modules/` มาให้ครบตามที่ README ระบุ
**แก้:** รัน `npm install` เพื่อโหลด dependency ตาม `package.json`

## 3. Seed ฐานข้อมูล

```bash
npm run seed
```

**ปัญหาที่เจอ:** `Access denied for user 'root'@'localhost' (using password: YES)`
**สาเหตุ:** พอร์ต 3306 บนเครื่องถูกใช้งานโดย MySQL อื่นที่ติดตั้งไว้ในเครื่องอยู่ก่อนแล้ว ทำให้แอปเชื่อมกับ MySQL ตัวนั้นแทน container ของ Docker
**วิธีตรวจสอบ:**
```bash
netstat -ano | findstr 3306
tasklist /FI "PID eq <PID ที่เจอ>"
```
**แก้:** หยุด MySQL service ที่ชนพอร์ตก่อน (ผ่าน `services.msc` หรือ `net stop MySQL80` แบบ Run as Administrator) แล้วเริ่ม container ใหม่:
```bash
docker compose down -v
docker compose up -d
docker compose ps   # เช็คว่า mysql ขึ้นสถานะ (healthy)
npm run seed
```

## 4. รันเซิร์ฟเวอร์

```bash
npm run dev
```
เปิดที่ `http://localhost:3000`

## 5. เช็คข้อมูลใน MySQL โดยตรง

```bash
docker compose exec mysql mysql -uroot -proot exam_db
```
เมื่อเข้า mysql prompt แล้ว:
```sql
SHOW TABLES;
SELECT * FROM courses;
SELECT * FROM courses LIMIT 10;
SELECT course_name, credit FROM courses;
exit
```

## 6. Push ขึ้น GitHub

```bash
git init
git add .
git commit -m "midterm submission"
git branch -M main
git remote add origin https://github.com/Sirapob0110/midterm.git
git push -u origin main
```

**ปัญหาที่เจอ:** `error: src refspec main does not match any`
**สาเหตุ:** ยังไม่มี commit อยู่บน branch ก่อน push
**แก้:** ต้อง `git add` + `git commit` อย่างน้อย 1 ครั้งก่อน push เสมอ

**ข้อควรระวัง:** สร้าง `.gitignore` ก่อน `git add .` เพื่อไม่ให้หลุด `node_modules/` และ `.env` ขึ้นไปบน repo:
```
node_modules/
.env
```

## ไฟล์ที่แก้ในโปรเจกต์นี้

- `routes/courses.js`
- `answers.md`
