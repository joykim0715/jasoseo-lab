# Notion 스키마 — 자소서 자동화

웹앱(`jasoseo`)은 Notion Internal Integration API로 아래 DB를 읽습니다.  
Cursor는 공식 Notion MCP(`https://mcp.notion.com/mcp`)로 동일 워크스페이스를 정리·시딩합니다.

## 1. Experience Bank

자소서에 재사용할 STAR/성과 단위.

| Property | Type | Notes |
|----------|------|--------|
| Name | title | 한 줄 제목 |
| Tags | multi-select | 데이터, 헬스케어, 리더십, 협업 등 |
| Role | select | Lead / Member / Solo 등 |
| Situation | rich_text | STAR — S |
| Task | rich_text | STAR — T |
| Action | rich_text | STAR — A |
| Result | rich_text | STAR — R |
| Metrics | rich_text | 수치·임팩트 |
| Skills | multi-select | 기술·툴 |
| PortfolioWorkId | rich_text | 포트폴리오 work `id` 매핑 |
| PreferredQuestions | multi-select | 지원동기, 직무역량, 협업, 성장 |

## 2. Essay Archive

과거 자소서 참고용.

| Property | Type | Notes |
|----------|------|--------|
| Name | title | 회사·포지션 |
| Company | rich_text | 회사명 |
| Role | rich_text | 지원 포지션 |
| Question | rich_text | 문항 |
| Answer | rich_text | 본문 |
| CharCount | number | 실제 글자 수 |
| Tone | select | 담백 / 설득 / 스토리 |
| Rating | select | High / Medium / Low (재사용 우선순위) |

## Cursor MCP 연결

1. 글로벌 `C:\Users\82103\.cursor\mcp.json` 과 프로젝트 [`.cursor/mcp.json`](../../.cursor/mcp.json)에 Notion MCP가 설정됨 (`type: http`).
2. Cursor를 **한 번 재시작**한 뒤 **Settings → Tools & MCP**에서 `notion` 확인.
3. `notion` 옆 **Needs login / Connect** → 브라우저 OAuth 완료.
4. 그래도 안 보이면 Settings → MCP → **Add new global MCP server**에 아래 JSON 붙여넣기:

```json
{
  "mcpServers": {
    "notion": {
      "type": "http",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

5. HTTP가 실패하면 stdio 브리지로 교체:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"]
    }
  }
}
```

6. MCP로 Experience Bank / Essay Archive DB를 만든 뒤, 웹앱 Integration에 DB를 공유(Share → Integration).

## 웹앱 Internal Integration

1. [Notion My Integrations](https://www.notion.so/my-integrations)에서 Internal Integration 생성.
2. 생성된 토큰을 `NOTION_TOKEN`에 넣기.
3. 각 DB 페이지에서 Integration 연결.
4. DB ID(또는 data source ID)를 URL의 32자 hex에서 추출해 env에 설정:
   - `NOTION_EXPERIENCE_DB_ID`
   - `NOTION_ESSAY_DB_ID`

앱은 Notion SDK v5 `dataSources.query`를 사용합니다. Database ID를 넣으면 자동으로 첫 data source로 해석을 시도합니다.

토큰·DB가 없어도 앱은 포트폴리오 스냅샷만으로 동작합니다 (Notion은 선택).
