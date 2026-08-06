# 자소서 랩

취업 공고를 분석하고 포트폴리오·Notion 경험에 맞춘 자기소개서 초안을 만드는 웹앱입니다.

**라이브:** https://jasoseo-lab.vercel.app  
**포트폴리오:** https://kiminhong-portfolio.vercel.app
**GitHub:** https://github.com/joykim0715/jasoseo-lab

## 로컬 실행

```bash
cp .env.example .env.local
# ANTHROPIC_API_KEY 필수
npm install
npm run dev
```

## Vercel 환경변수 (필수만)

| Key | 필수 | 설명 |
|-----|------|------|
| `ANTHROPIC_API_KEY` | **Yes** | Claude API — 없으면 분석/생성 불가 |
| `NEXT_PUBLIC_SITE_URL` | 권장 | 배포 URL |
| `NEXT_PUBLIC_PORTFOLIO_URL` | 선택 | 기본 포트폴리오 URL |
| `NOTION_TOKEN` | 선택 | Notion Integration |
| `NOTION_EXPERIENCE_DB_ID` | 선택 | Experience Bank |
| `NOTION_ESSAY_DB_ID` | 선택 | Essay Archive |

노션 스키마: [docs/notion-schema.md](docs/notion-schema.md)

## 플로우

1. `/` 공고 입력 (텍스트·URL·문서·이미지)
2. `/setup` 문항 · 글자 수 · 제약
3. `/result` 페르소나 + 문항별 초안 · 복사
