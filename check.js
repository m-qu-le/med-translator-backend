import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ 
    apiKey: "AQ.Ab8RN6KT0reAEE6lgscP_lf7zqgAvnH4ygyFTAmhAe99xsJrwg" 
});

async function listMyModels() {
    console.log("🔍 Đang soi danh sách Model được phép dùng...");
    try {
        // Gọi thẳng hàm ListModels như log yêu cầu
        const response = await ai.models.list();
        for await (const model of response) {
            // Chỉ in ra tên model
            console.log(`- ${model.name}`);
        }
    } catch (error) {
        console.error("Lỗi:", error);
    }
}

listMyModels();