import { GoogleGenAI } from '@google/genai';
import pLimit from 'p-limit';

// [ĐÃ SỬA]: Lazy Loading (Lấy Key khi thực thi thay vì lấy lúc khởi tạo file)
const getApiKeys = () => {
    const keys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
    if (keys.length === 0) {
        console.error("🔴 [CẢNH BÁO]: Chưa tìm thấy GEMINI_API_KEYS trong file .env!");
    }
    return keys;
};

const TARGET_MODEL = 'gemini-3.1-flash-lite'; 
let currentKeyIndex = 0;

const SYSTEM_INSTRUCTION = `
Bạn là một Chuyên gia Dịch thuật Y khoa và Kỹ sư Xử lý Dữ liệu cấp cao. Nhiệm vụ của bạn là dịch các đoạn trích (chunk) từ sách y học cơ sở và lâm sàng tiếng Anh sang tiếng Việt, đồng thời định dạng chuẩn Markdown.

QUY TẮC DỊCH THUẬT (TUÂN THỦ 100%):
Phong cách dịch cần: Học thuật, chính xác, khách quan, rõ ràng, mạch lạc, và nhất quán.
Giọng văn cần: Giữ nguyên giọng văn khoa học, chuyên nghiệp của bản gốc.
Tránh: Sử dụng từ ngữ mơ hồ, không chính xác về mặt y khoa, hoặc dịch sát từng chữ gây khó hiểu trong ngữ cảnh y học.

YÊU CẦU CHẤT LƯỢNG:
1. Độ chính xác y khoa: Đảm bảo bản dịch chính xác tuyệt đối về mặt ngữ nghĩa, thông tin y học, và các quy trình lâm sàng.
2. Độ tự nhiên: Bản dịch phải trôi chảy, phù hợp với cách diễn đạt trong tài liệu y khoa tiếng Việt, tránh cảm giác "dịch máy".
3. Thuật ngữ: Dịch chính xác theo chuẩn y khoa Việt Nam. Giữ lại nguyên bản tiếng Anh trong ngoặc đơn đối với thuật ngữ phức tạp ở lần xuất hiện đầu tiên.
4. Xử lý tên riêng/viết tắt: Giữ nguyên tên riêng, tên thuốc, tên vi khuẩn. Đối với từ viết tắt, giữ nguyên tiếng Anh và giải thích nghĩa tiếng Việt ở lần đầu (VD: 'ARDS (Acute Respiratory Distress Syndrome - Hội chứng suy hô hấp cấp tính)').

YÊU CẦU ĐẶC BIỆT (PHẢI TUÂN THỦ 100%)
- ĐẢM BẢO DỊCH TOÀN VĂN TÀI LIỆU, không tự ý tóm tắt, rút gọn tài liệu.

HUÓNG DẪN XỬ LÝ HÌNH ẢNH:
- Dịch tiêu đề và miêu tả của hình ảnh mỗi khi hình ảnh xuất hiện
- Dịch các cụm từ/ từ xuất hiện trong hình ảnh.

QUY QUY TẮC ĐỊNH DẠNG:
- KHÔNG chào hỏi, CHỈ TRẢ VỀ Markdown.
- Phân cấp Heading (#, ##, ###) bám sát gốc. 
- Chuyển đổi bảng biểu thành Markdown Table.
- Xử lý ký hiệu: Dùng văn bản thuần thay cho Latex (VD: α, β, O2, NH3, →).
- Không sử dụng Dấu phân chia 3 gạch ngang trong Markdown (hay còn gọi là đường kẻ ngang - Horizontal Rule)

LƯU Ý KHI PHÂN CẤP HEADING MARKDOWN:
- Không đặt Heading cho tiêu đề ảnh và chú thích hình ảnh
VD: 
- Không dùng "### Hình 22–3: Các giai đoạn của nang trứng, từ nguyên thủy đến trưởng thành." mà dùng "**Hình 22–3: Các giai đoạn của nang trứng, từ nguyên thủy đến trưởng thành.**
`;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getAiInstance(keyIndex) {
    return new GoogleGenAI({ 
        apiKey: getApiKeys()[keyIndex] 
    });
}

function rotateApiKey(emitLog, chunkLabel, failedIndex) {
    const keysCount = getApiKeys().length;
    if (currentKeyIndex === failedIndex) {
        const oldIndex = currentKeyIndex;
        currentKeyIndex = (currentKeyIndex + 1) % keysCount;
        emitLog(`🔄 [${chunkLabel}] ĐÃ ĐỔI API KEY: Từ Key ${oldIndex + 1} sang Key ${currentKeyIndex + 1}`);
    } else {
        emitLog(`ℹ️ [${chunkLabel}] API Key đã được tiến trình khác đổi sang Key ${currentKeyIndex + 1}, tiếp tục đồng bộ...`);
    }
}

async function callGeminiWithKeyRotation(base64Data, chunkLabel, emitLog) {
    let keysTried = 0;
    let lastError = null;
    const keysCount = getApiKeys().length;

    while (keysTried < keysCount) {
        let retries = 0;
        const maxRetriesPerKey = 5; 
        const attemptingKeyIndex = currentKeyIndex; 

        while (retries <= maxRetriesPerKey) {
            try {
                const ai = getAiInstance(attemptingKeyIndex); 
                const response = await ai.models.generateContent({
                    model: TARGET_MODEL,
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                { inlineData: { data: base64Data, mimeType: 'application/pdf' } },
                                { text: 'Dịch đoạn tài liệu đính kèm sang tiếng Việt theo đúng cấu trúc Markdown.' }
                            ]
                        }
                    ],
                    config: {
                        systemInstruction: SYSTEM_INSTRUCTION,
                        temperature: 0.1 
                    }
                });

                return { 
                    text: response.text, 
                    modelUsed: TARGET_MODEL, 
                    keyUsed: `Key ${attemptingKeyIndex + 1}` 
                };

            } catch (error) {
                lastError = error;
                const status = error?.status || error?.response?.status || 500;

                if (status === 429 || status === 503) {
                    if (retries < maxRetriesPerKey) {
                        retries++;
                        // [ĐÃ SỬA]: Thay đổi hệ số nhân từ 3000 thành 12000
                        const waitTime = retries * 12000; 
                        
                        emitLog(`⚠️ [${chunkLabel}] API Key ${attemptingKeyIndex + 1} đang bận (Lỗi ${status}). Đợi ${waitTime/1000}s thử lại lần ${retries}/${maxRetriesPerKey}...`);
                        await delay(waitTime);
                    } else {
                        emitLog(`🛑 [${chunkLabel}] API Key ${attemptingKeyIndex + 1} THẤT BẠI sau ${maxRetriesPerKey} lần thử.`);
                        break; 
                    }
                } else {
                    throw error; 
                }
            }
        } 

        rotateApiKey(emitLog, chunkLabel, attemptingKeyIndex);
        keysTried++;
    } 

    throw new Error(`Tuyệt vọng! Đã thử toàn bộ ${keysCount} API Keys nhưng đều thất bại. Lỗi cuối cùng: ${lastError?.message}`);
}

async function translateSingleChunk(buffer, chunkIndex, emitLog) {
    const chunkLabel = `Chunk ${chunkIndex + 1}`;
    let base64Data;

    try {
        // 🛠️ FIX: Kiểm tra an toàn loại dữ liệu trả về từ Worker
        const validBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        base64Data = validBuffer.toString('base64');

        // Chặn luồng ngay nếu dữ liệu Worker truyền về quá nhỏ (Bị lỗi hỏng file)
        if (!base64Data || base64Data.length < 100) {
            throw new Error(`Dữ liệu PDF bị hỏng trong quá trình truyền tải Đa luồng (Kích thước chuỗi Base64: ${base64Data.length}).`);
        }
        
        emitLog(`⏳ [${chunkLabel}] Bắt đầu dịch... (Đang nạp Key ${currentKeyIndex + 1})`);
        const result = await callGeminiWithKeyRotation(base64Data, chunkLabel, emitLog);
        
        emitLog(`✅ [${chunkLabel}] Xong! (Dùng: ${result.modelUsed} - Bằng: ${result.keyUsed})`);
        return result.text;
    } catch (error) {
        emitLog(`❌ LỖI NGHIÊM TRỌNG tại ${chunkLabel}: ${error.message}`);
        throw error;
    }
}

export const processTranslation = async (chunkBuffers, emitLog) => {
    const limit = pLimit(2); 
    const keysCount = getApiKeys().length;
    emitLog(`🚀 Đang băm thành ${chunkBuffers.length} chunk. Hệ thống Key Rotation đã sẵn sàng với ${keysCount} Keys...`);

    const promises = chunkBuffers.map((buffer, index) => 
        limit(() => translateSingleChunk(buffer, index, emitLog))
    );

    const translatedChunks = await Promise.all(promises);
    return translatedChunks.join('\n\n---\n\n');
};