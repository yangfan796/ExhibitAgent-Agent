# 展会信息 Agent（3 分钟跑起来）

## 1. 环境
- Node.js ≥ 18
- 通义百炼 API Key：`DASHSCOPE_API_KEY=sk-xxxx`

## 2. 安装
```bash
npm install
```

## 3. 启动
```bash
# Windows（PowerShell）
$env:DASHSCOPE_API_KEY="sk-xxxx"; npm run start

# macOS / Linux
DASHSCOPE_API_KEY="sk-xxxx" npm run start
```

## 4. 访问
- 打开 http://localhost:3000/
- 输入你的问题即可体验流式对话

## 可选：Docker 启动
```bash
docker build -t exhibit-agent .
docker run -p 3000:3000 -e DASHSCOPE_API_KEY=sk-xxxx exhibit-agent
```
