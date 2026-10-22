# 示例：写入 hello.txt

规划者必须只返回 JSON，不能改文件。下面的任务列表已经写好；遵守提示词的模型会原样返回它。也可以删掉 JSON，只留自然语言，让强模型自己拆任务。

```json
{
  "tasks": [
    {
      "id": "hello",
      "title": "Write hello",
      "instructions": "Create hello.txt containing exactly hello",
      "acceptance": ["hello.txt exists and its trimmed contents are hello"],
      "test_command": "node -e \"const fs=require('fs'); if (fs.readFileSync('hello.txt','utf8').trim()!=='hello') process.exit(1)\""
    }
  ]
}
```
