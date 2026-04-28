import multer from 'multer';
import fs from 'fs';

// Tạo thư mục tạm 'uploads' ở thư mục gốc của project nếu chưa có
const uploadDir = 'uploads/';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

// Cấu hình lưu trữ file xuống ổ cứng (Disk Storage)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // 1. GIẢI MÃ ENCODING: Ép ngược từ latin1 sang utf8 để giữ nguyên tiếng Việt và ký tự đặc biệt
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');

        // 2. SANITIZE (Vệ sinh tên file - Optional nhưng là Best Practice của System Architect): 
        // Xóa hoặc thay thế các ký tự có thể gây lỗi đường dẫn trên hệ điều hành (như \ / : * ? " < > |)
        const safeName = decodedName.replace(/[\\/:*?"<>|]/g, '-');

        // 3. Gắn timestamp chống trùng lặp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + safeName);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Chỉ chấp nhận file PDF (Giữ nguyên logic của bạn)
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Chỉ chấp nhận định dạng file PDF.'), false);
        }
    },
    limits: {
        fileSize: 500 * 1024 * 1024 // Giới hạn 500MB cho mỗi lần upload sách
    }
});

export default upload;