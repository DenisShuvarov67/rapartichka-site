const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const { google } = require('googleapis');

// --- ВСТАВЬТЕ СЮДА ---
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

if (process.env.GOOGLE_CREDENTIALS && !fs.existsSync(CREDENTIALS_PATH)) {
    fs.writeFileSync(CREDENTIALS_PATH, process.env.GOOGLE_CREDENTIALS);
}
const SHEETS_CREDENTIALS = CREDENTIALS_PATH;
// --- КОНЕЦ ВСТАВКИ ---

const app = express();

const PORT = process.env.PORT || 6001;

const USERS_FILE = path.join(__dirname, 'users.json');
const ADMIN_CREDENTIALS_FILE = path.join(__dirname, 'admin_credentials.json');
const LOGIN_HISTORY_FILE = path.join(__dirname, 'login_history.json');
const STUDENTS_FILE = path.join(__dirname, 'students.json');
const SUBJECTS_FILE = path.join(__dirname, 'subjects.json');

// Вставьте вашу строку подключения ниже
const pool = new Pool({
    connectionString: 'postgresql://postgres.emavakahyqyabufpaypv:NfM2JSEkQtVB4rh5@aws-0-eu-north-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// Получение истории входов пользователя
function getLoginHistory(username) {
    if (!fs.existsSync(LOGIN_HISTORY_FILE)) return [];
    const all = JSON.parse(fs.readFileSync(LOGIN_HISTORY_FILE, 'utf8'));
    // Поиск без учёта регистра
    const key = Object.keys(all).find(k => k.toLowerCase() === username.toLowerCase());
    return key ? all[key] : [];
}

// Сохранение попытки входа
function saveLoginAttempt(username, ip) {
    let all = {};
    if (fs.existsSync(LOGIN_HISTORY_FILE)) {
        all = JSON.parse(fs.readFileSync(LOGIN_HISTORY_FILE, 'utf8'));
    }
    if (!all[username]) all[username] = [];
    all[username].push({ time: Date.now(), ip });
    fs.writeFileSync(LOGIN_HISTORY_FILE, JSON.stringify(all, null, 2));
}

// Вход пользователя
app.post('/login', (req, res) => {
    const { password, force, role } = req.body;
    const username = (req.body.username || '').trim();
    if (!fs.existsSync(USERS_FILE)) {
        return res.status(401).json({ error: 'Нет пользователей' });
    }
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    // Проверяем не только логин и пароль, но и роль
    const user = users.find(u =>
        u.username === username &&
        u.password === password &&
        ((role && u.role && u.role.toLowerCase() === role.toLowerCase()) ||
         (role && u.roleName && u.roleName.toLowerCase() === role.toLowerCase()))
    );

    // --- ДОБАВЬ ЭТО ---
    if (user && user.blockedUntil && Date.now() < user.blockedUntil) {
        return res.status(403).json({ error: `Пользователь заблокирован до ${new Date(user.blockedUntil).toLocaleString()}` });
    }

    if (!user) {
        return res.status(401).json({ error: 'Неверный логин, пароль или роль' });
    }

    // Получаем IP
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    // Преобразуем ::1 и 127.0.0.1 в адрес сайта для удобства
    if (ip === '::1' || ip === '127.0.0.1') ip = 'rapartichka-site.onrender.com';

    // Получаем историю входов
    const history = getLoginHistory(username);
    const now = Date.now();
    const lastHour = history.filter(h => now - h.time < 60 * 60 * 1000);
    const attempts = lastHour.length + 1;

    // Формируем историю для клиента (последние 5 записей)
    const lastLogins = history.slice(-5).map(h => ({
        time: h.time,
        ip: h.ip
    }));

    let warning = null;
    if ((lastHour.length >= 1 && lastHour.length < 20 && !force) ||
        (lastHour.length >= 20 && !force)) {
        warning = lastHour.length >= 5
            ? `Вы слишком часто заходите (${attempts} раз за час).\nВаш IP: ${ip}\nЗайдите через 1 час или подтвердите вход.`
            : `Вы уже входили ${attempts} раза за последний час.\nВаш IP: ${ip}\nВы уверены, что хотите войти?`;
        // Если force=true, сохраняем попытку и возвращаем обновлённую историю
        if (force) {
            saveLoginAttempt(username, ip);
            const updatedHistory = getLoginHistory(username);
            const updatedLastLogins = updatedHistory.slice(-5).map(h => ({
                time: h.time,
                ip: h.ip
            }));
            return res.json({
                username: user.username,
                fullName: user.fullName,
                role: user.role,
                roleName: user.roleName,
                ip,
                attempts,
                lastLogins: updatedLastLogins
            });
        } else {
            return res.json({
                warning,
                ip,
                attempts,
                lastLogins
            });
        }
    }

    // Сохраняем попытку входа, если force не нужен (обычный вход)
    saveLoginAttempt(username, ip);
    const updatedHistory = getLoginHistory(username);
    const updatedLastLogins = updatedHistory.slice(-5).map(h => ({
        time: h.time,
        ip: h.ip
    }));

    res.json({
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        roleName: user.roleName,
        ip,
        attempts,
        lastLogins: updatedLastLogins
    });
});

// Получение данных посещаемости из файла
// app.get('/attendance', (req, res) => {
//     if (!fs.existsSync(ATTENDANCE_FILE)) {
//         return res.status(404).json({ error: 'Файл посещаемости не найден' });
//     }
//     const data = JSON.parse(fs.readFileSync(ATTENDANCE_FILE, 'utf8'));
//     res.json(data);
// });

// Добавление новой записи о посещаемости в базу данных
app.post('/attendance', async (req, res) => {
    const { date, student, subject, status, comment, lesson } = req.body;
    try {
        await pool.query(
            'INSERT INTO attendance (date, student_id, subject_id, status, comment, lesson) VALUES ($1, $2, $3, $4, $5, $6)',
            [date, student, subject, status, comment, lesson]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных', details: e.message });
    }
});

// Получение данных о пропусках (теперь из attendance.json)
app.get('/absences', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                attendance.id,
                attendance.date,
                students.name AS student,
                subjects.name AS subject,
                attendance.status,
                attendance.comment,
                attendance.lesson -- добавьте это поле!
            FROM attendance
            LEFT JOIN students ON attendance.student_id = students.id
            LEFT JOIN subjects ON attendance.subject_id = subjects.id
            ORDER BY attendance.date DESC
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Добавление новой записи о пропуске (опционально)
// app.post('/absences', (req, res) => {
//     const newRecord = req.body;
//     let data = [];
//     if (fs.existsSync(ABSENCES_FILE)) {
//         data = JSON.parse(fs.readFileSync(ABSENCES_FILE, 'utf8'));
//     }
//     if (!Array.isArray(data)) data = [];
//     data.push(newRecord);
//     fs.writeFileSync(ABSENCES_FILE, JSON.stringify(data, null, 2));
//     res.json({ success: true });
// });

// Удаление записи о пропуске из файла
// app.delete('/absences', (req, res) => {
//     if (!fs.existsSync(ATTENDANCE_FILE)) {
//         return res.status(404).json({ error: 'Файл attendance.json не найден' });
//     }
//     const toDelete = req.body;
//     let data = JSON.parse(fs.readFileSync(ATTENDANCE_FILE, 'utf8'));
//     data = data.filter(row => !(
//         row.date === toDelete.date &&
//         row.student === toDelete.student &&
//         row.subject === toDelete.subject &&
//         row.status === toDelete.status &&
//         (row.comment || '') === (toDelete.comment || '')
//     ));
//     fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(data, null, 2));
//     res.json({ success: true });
// });

// Регистрация нового пользователя
app.post('/register', (req, res) => {
    const newUser = req.body;
    if (!newUser.username || !newUser.password) {
        return res.status(400).json({ error: 'Не указаны имя пользователя или пароль' });
    }

    // Если роль родитель — сохраняем в parents.json
    if (newUser.role === 'parent') {
        const PARENTS_FILE = path.join(__dirname, 'parents.json');
        let parents = [];
        if (fs.existsSync(PARENTS_FILE)) {
            parents = JSON.parse(fs.readFileSync(PARENTS_FILE, 'utf8'));
        }
        if (parents.some(p => p.username === newUser.username)) {
            return res.status(409).json({ error: 'Родитель с таким логином уже существует' });
        }
        parents.push(newUser);
        fs.writeFileSync(PARENTS_FILE, JSON.stringify(parents, null, 2), 'utf8');
        return res.json({ success: true });
    }

    // Обычные пользователи — сохраняем в users.json
    let users = [];
    if (fs.existsSync(USERS_FILE)) {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
    if (users.some(u => u.username === newUser.username)) {
        return res.status(409).json({ error: 'Пользователь уже существует' });
    }
    users.push(newUser);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    res.json({ success: true });
});

// Вход администратора (отдельно от обычных пользователей)
app.post('/admin-login', (req, res) => {
    const { username, password } = req.body;
    const credentialsPath = path.join(__dirname, 'admin_credentials.json');
    fs.readFile(credentialsPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Ошибка чтения файла' });
        try {
            const admin = JSON.parse(data);
            if (admin.username === username && admin.password === password) {
                res.json({ success: true, role: 'admin', fullName: admin.fullName });
            } else {
                res.json({ success: false, error: 'Неверный логин или пароль' });
            }
        } catch (e) {
            res.status(500).json({ error: 'Ошибка парсинга файла' });
        }
    });
});

// Изменение учетных данных администратора
app.post('/change-admin-credentials', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Необходимо указать логин и пароль' });
    }
    if (!fs.existsSync(ADMIN_CREDENTIALS_FILE)) {
        return res.status(500).json({ error: 'Файл с данными администратора не найден' });
    }
    const admin = JSON.parse(fs.readFileSync(ADMIN_CREDENTIALS_FILE, 'utf8'));
    admin.username = username;
    admin.password = password;
    fs.writeFileSync(ADMIN_CREDENTIALS_FILE, JSON.stringify(admin, null, 2));
    res.json({ success: true });
});

// Получение списка пользователей (новый эндпоинт)
app.get('/users', (req, res) => {
    if (!fs.existsSync(USERS_FILE)) return res.json([]);
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    res.json(users);
});

// Удаление пользователя
app.delete('/users/:username', (req, res) => {
    if (!fs.existsSync(USERS_FILE)) return res.status(404).json({ error: 'Файл не найден' });
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const username = req.params.username;
    const newUsers = users.filter(u => u.username !== username);
    if (newUsers.length === users.length) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(newUsers, null, 2));
    res.json({ success: true });
});

// Изменение ролей пользователя
app.put('/users/:username/roles', (req, res) => {
    if (!fs.existsSync(USERS_FILE)) return res.status(404).json({ error: 'Файл не найден' });
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const username = req.params.username;
    const { additionalRoles } = req.body;
    const userIndex = users.findIndex(u => u.username === username);
    if (userIndex === -1) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    users[userIndex].additionalRoles = additionalRoles;
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    res.json({ success: true });
});

// Изменение аватара пользователя
app.put('/users/:username/avatar', (req, res) => {
    if (!fs.existsSync(USERS_FILE)) return res.status(404).json({ error: 'Файл не найден' });
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const username = req.params.username;
    const { avatar } = req.body;
    const userIndex = users.findIndex(u => u.username === username);
    if (userIndex === -1) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    users[userIndex].avatar = avatar;
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    res.json({ success: true });
});

// Смена пароля пользователя
app.put('/users/:username/password', (req, res) => {
    if (!fs.existsSync(USERS_FILE)) return res.status(404).json({ error: 'Файл не найден' });
    let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    const username = decodeURIComponent(req.params.username);
    const { password } = req.body;
    const userIndex = users.findIndex(u => u.username === username);
    if (userIndex === -1) {
        return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    }
    users[userIndex].password = password;
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    res.json({ success: true });
});

// Получить список студентов из PostgreSQL
app.get('/students', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name FROM students ORDER BY name');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Добавить студента в PostgreSQL
app.post('/students', async (req, res) => {
    const { name } = req.body;
    try {
        await pool.query('INSERT INTO students(name) VALUES($1) ON CONFLICT DO NOTHING', [name]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Удалить студента из PostgreSQL
app.delete('/students', async (req, res) => {
    const { id } = req.body;
    try {
        await pool.query('DELETE FROM students WHERE id=$1', [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Получить список предметов из PostgreSQL
app.get('/subjects', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name FROM subjects ORDER BY name');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Добавить предмет в PostgreSQL
app.post('/subjects', async (req, res) => {
    const { name } = req.body;
    try {
        await pool.query('INSERT INTO subjects(name) VALUES($1) ON CONFLICT DO NOTHING', [name]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Удалить предмет из PostgreSQL
app.delete('/subjects', async (req, res) => {
    const { id } = req.body;
    try {
        await pool.query('DELETE FROM subjects WHERE id=$1', [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Тестирование подключения к базе данных
app.get('/db-test', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ time: result.rows[0].now });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Удаление записи о посещаемости по id
app.delete('/absences', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Не передан id' });
    try {
        await pool.query('DELETE FROM attendance WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Получить список участников группы
app.get('/group-members', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name AS "fullName", duty, birth FROM group_members ORDER BY id');
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Добавить участника группы
app.post('/group-members', async (req, res) => {
    const { fullName, duty, birth } = req.body;
    if (!fullName || !duty) {
        return res.status(400).json({ error: 'Не указаны ФИО или обязанность' });
    }
    try {
        await pool.query(
            'INSERT INTO group_members(full_name, duty, birth) VALUES($1, $2, $3)',
            [fullName, duty, birth || null]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Удалить участника группы (по id)
app.delete('/group-members', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Не передан id' });
    try {
        await pool.query('DELETE FROM group_members WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Изменить участника группы (ФИО и/или обязанность)
app.patch('/group-members', async (req, res) => {
    const { id, fullName, duty, birth } = req.body;
    if (!id) return res.status(400).json({ error: 'Не передан id' });
    try {
        await pool.query(
            'UPDATE group_members SET full_name = $1, duty = $2, birth = $3 WHERE id = $4',
            [fullName, duty, birth || null, id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Получить название группы
app.get('/group-info', async (req, res) => {
    try {
        const result = await pool.query('SELECT name FROM group_info WHERE id = 1');
        if (result.rows.length) {
            res.json({ name: result.rows[0].name });
        } else {
            res.json({ name: 'Без названия' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Изменить название группы
app.patch('/group-info', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Не указано название' });
    try {
        await pool.query(
            `INSERT INTO group_info(id, name) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
            [name]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Получить куратора группы из users.json
app.get('/curator', (req, res) => {
    if (!fs.existsSync(USERS_FILE)) return res.json({ curator: null });
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    // Ищем пользователя с ролью "куратор" или "curator"
    const curator = users.find(u =>
        (u.role && u.role.toLowerCase() === 'curator') ||
        (u.roleName && u.roleName.toLowerCase() === 'куратор')
    );
    if (curator) {
        res.json({ curator: curator.fullName || curator.username });
    } else {
        res.json({ curator: null });
    }
});

// Получить старосту
app.get('/headman', async (req, res) => {
    try {
        const result = await pool.query('SELECT headman FROM group_info WHERE id = 1');
        res.json({ headman: result.rows[0]?.headman || null });
    } catch {
        res.json({ headman: null });
    }
});

// Изменить старосту
app.patch('/headman', async (req, res) => {
    const { headman } = req.body;
    try {
        await pool.query(
            `UPDATE group_info SET headman = $1 WHERE id = 1`,
            [headman]
        );
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Получить количество студентов
app.get('/students-count', async (req, res) => {
    try {
        const result = await pool.query('SELECT students_count FROM group_info WHERE id = 1');
        res.json({ count: result.rows[0]?.students_count || 0 });
    } catch {
        res.json({ count: 0 });
    }
});

// Изменить количество студентов
app.patch('/students-count', async (req, res) => {
    const { count } = req.body;
    try {
        await pool.query(
            `UPDATE group_info SET students_count = $1 WHERE id = 1`,
            [count]
        );
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

// Блокировка пользователя до указанной даты
app.post('/block-user', async (req, res) => {
    const { username, blockedUntil } = req.body;
    if (!username || !blockedUntil) return res.status(400).json({ error: 'Нет данных' });
    try {
        await pool.query(
            'UPDATE users SET blocked_until = $1 WHERE username = $2',
            [blockedUntil, username]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка базы данных' });
    }
});

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz7a5tTz8NVUQlTzGlDn4GxoveNOjM5ka6wttMWMyoI-YYWOLMJ18Brn6aww8hJ1VFNEw/exec'

// Прокси для GET (таблица посещаемости)
app.get('/google-attendance', async (req, res) => {
    try {
        const client = await sheetsAuth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Лист1!A1:E100', // диапазон в вашей таблице
        });
        res.json(response.data.values);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка Google Sheets API', details: e.message });
    }
});

// Прокси для POST (отправка формы)
app.post('/google-attendance', async (req, res) => {
    try {
        const client = await sheetsAuth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const values = [Object.values(req.body)];
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'Лист1!A1', // диапазон для добавления
            valueInputOption: 'RAW',
            resource: { values },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка Google Sheets API', details: e.message });
    }
});

const SHEET_ID = '1D9q9pgjVbQIHoF6WBv4muId-w2hmh6ZgBZJjt-bvmvE'; // скопируйте из адреса Google Таблицы

const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: SHEETS_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на https://rapartichka-site.onrender.com`);
});