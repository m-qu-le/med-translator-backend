import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

async function testGeminiKeys() {
    // Trích xuất chuỗi keys từ biến môi trường, phân tách bằng dấu phẩy
    const keysString = process.env.GEMINI_API_KEYS;
    
    if (!keysString) {
        console.error("❌ Không tìm thấy GEMINI_API_KEYS trong biến môi trường.");
        return;
    }

    // Làm sạch mảng keys
    const keys = keysString.split(',').map(k => k.trim()).filter(k => k !== '');
    console.log(`🔍 Bắt đầu kiểm tra ${keys.length} API Keys...\n`);

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        // Che key khi in ra log để bảo mật
        const maskedKey = `${key.substring(0, 8)}...${key.substring(key.length - 4)}`;
        
        try {
            // Khởi tạo client với key hiện tại
            const ai = new GoogleGenAI({ apiKey: key });
            
            // Gửi request siêu nhẹ kiểm tra kết nối
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite-preview',
                contents: 'Reply strictly with the word "OK"',
            });
            
            console.log(`✅ Key ${i + 1} (${maskedKey}): HOẠT ĐỘNG TỐT - Phản hồi: ${response.text}`);
        } catch (error) {
            console.log(`❌ Key ${i + 1} (${maskedKey}): LỖI`);
            
            // Trích xuất thông báo lỗi từ đối tượng GoogleGenAI Error
            if (error.status === 400 || (error.message && error.message.includes('location is not supported'))) {
                console.log(`   👉 Mã lỗi: 400 - Bị chặn địa lý (Location not supported)`);
            } else if (error.status === 429) {
                console.log(`   👉 Mã lỗi: 429 - Hết Quota (Rate limit exceeded)`);
            } else {
                console.log(`   👉 Chi tiết: ${error.message}`);
            }
        }
    }
    console.log("\n🏁 Hoàn thành kiểm tra.");
}

testGeminiKeys();