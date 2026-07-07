import OpenAI from 'openai'
import { imageKey, imageBaseURL } from '../../key.js'

const client = new OpenAI({
    apiKey: imageKey,
    baseURL: imageBaseURL,
})

async function main() {
  try {
    // 2. 发起流式请求
    const stream = await client.chat.completions.create({
        model: "qwen3.7-plus",
        messages: [
            { role: "system", content: "你是一个全栈开发助手，你要简要准确描述图片的内容，如果涉及到修改样式需要给出相应的css，不确定就直说不知道，不要反复纠正自己。" },
            { role: "user", content: [
              {type:"image_url",image_url:{url:"https://cdn.svipaigc.com/bizi/2024/02/0027479gmjq.jpg"}},
              {type:"text",text:"这个是什么游戏的图片？"}
            ]},
        ],
        stream: true,
        max_tokens: 1024,
        // 目的：在最后一个chunk中获取本次请求的Token用量。
        stream_options: { include_usage: true },
    });

    // 3. 处理流式响应
    const contentParts = [];
    process.stdout.write("AI: ");
    
    for await (const chunk of stream) {
        // 最后一个chunk不包含choices，但包含usage信息。
        if (chunk.choices && chunk.choices.length > 0) {
            const content = chunk.choices[0]?.delta?.content || "";
            process.stdout.write(content);
            contentParts.push(content);
        } else if (chunk.usage) {
            // 请求结束，打印Token用量。
            console.log("\n--- 请求用量 ---");
            console.log(`输入 Tokens: ${chunk.usage.prompt_tokens}`);
            console.log(`输出 Tokens: ${chunk.usage.completion_tokens}`);
            console.log(`总计 Tokens: ${chunk.usage.total_tokens}`);
        }
    }
    
    const fullResponse = contentParts.join("");
    console.log(`\n--- 完整回复 ---\n${fullResponse}`);

  } catch (error) {
      console.error("请求失败:", error);
  }
}

main()