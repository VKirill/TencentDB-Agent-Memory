<div align="center">

<img src="https://github.com/VKirill/codex-starter-kit/raw/main/assets/avatar-round.png" width="120" alt="VKirill — автор" />

# TencentDB Memory для Claude Code

**Постоянная память по проектам для [Claude Code](https://docs.anthropic.com/en/docs/claude-code) через MCP-сервер (4 tool'а) + 4-слойная цепочка извлечения L0 / L1 / L2 / L3.**
**Английская локализация и L3-персона под разработчиков**. Форк [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) — vector recall (Voyage embeddings), авто-инжекция в SessionStart, PM2-планировщик, orchestrator-синхронизация.

автор: **[@VKirill](https://github.com/VKirill)** · 📢 [Telegram-канал: @pomogay_marketing](https://t.me/pomogay_marketing)

🌐 [English](./README.md) · **Русский**

[![npm](https://img.shields.io/badge/npm-v0.5.0-blue)](https://github.com/VKirill/TencentDB-Memory-Claude-Code/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.16-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-orange)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-91%20passing-success)](#статус)

**Ключевые запросы**: claude code память, claude code mcp сервер, постоянная память claude, mcp memory, ai agent memory, persona, vector search, voyage embeddings, openrouter, sqlite-vec, l0 l1 l2 l3 extraction

</div>

---

## Что это делает

Claude Code отлично справляется с задачей перед глазами, но между сессиями
ничего не помнит. Каждый новый разговор начинается с нуля: ты заново объясняешь
свой стек, инфраструктуру, конвенции, что вы решили на прошлой неделе.

Этот пакет это чинит. Пока ты работаешь, он:

1. **Записывает** каждый turn разговора в локальный JSONL-файл (L0)
2. **Извлекает** устойчивые факты («Kirill использует Node 22, деплоит через PM2») с помощью LLM (L1)
3. **Группирует** связанные факты в тематические scene-файлы (`scene_blocks/server-infrastructure.md`) (L2)
4. **Дистиллирует** actionable coder-профиль (`persona.md`) — твой стек, инфра,
   workflow conventions, hard rules, активные проекты (L3)

При старте каждой новой сессии Claude Code SessionStart-хук прикрепляет твою
персону и индекс сцен к системному контексту Claude. MCP-сервер экспонирует
4 tool'a (`memory_search`, `conversation_search`, `recall_persona`,
`recall_scenes`) чтобы Claude мог искать специфику по запросу.

Результат: Claude в новой сессии уже знает тебя, твой стек и недавнюю работу —
не нужно ничего пере-объяснять.

---

## Быстрый старт (5 команд)

Требования: **Node ≥ 22.16**, установленный Claude Code, API-ключ OpenRouter
и API-ключ Voyage AI. См. [INSTALL.md](./INSTALL.md) — там полные детали.

```bash
# 1. Установка
npm i -g github:VKirill/TencentDB-Memory-Claude-Code#v0.5.0

# 2. Положи ключи в ~/.claude/claude-mem.env
cat > ~/.claude/claude-mem.env <<'EOF'
OPENROUTER_API_KEY=sk-or-v1-...
VOYAGE_API_KEY=pa-...
EOF
chmod 600 ~/.claude/claude-mem.env

# 3. Подключи хуки Claude Code + MCP-сервер (идемпотентно — безопасно перезапускать)
bash $(npm root -g)/@vkirill/tencentdb-memory-claude-code/claude-code-integration/install.sh

# 4. (Опционально) Пред-регистрация проектов в allowlist
#    Запуск Claude Code в любом проекте авто-добавит его на SessionStart (v0.4.1+).
#    Пропусти если не хочешь populate'ить allowlist до первой сессии.
# echo "$HOME/your-project" >> ~/.claude/claude-mem-projects.txt

# 5. (Опционально) Запусти PM2-демон, который раз в 30 минут запускает extract
pm2 start ~/.claude/hooks/claude-mem/scheduler.cjs --name claude-mem-scheduler
pm2 save
```

Проверка:

```bash
tencentdb-mem --version    # → 0.5.0
tencentdb-mem stats        # → состояние памяти текущего проекта
```

Затем стартуй новую Claude Code сессию в любом проекте из allowlist'a. Через
несколько минут / extraction'ов ты увидишь `<persona-context>` + `<scene-index>`
в session-start контексте, а Claude сможет вызывать MCP tool'ы.

---

## Архитектура

```
                       ┌──────────────────────────────────────┐
                       │  Claude Code сессия                  │
                       │                                       │
                       │  ┌──────────┐    ┌────────────────┐  │
   ты пишешь ─────►    │  │ User     │    │ MCP tools      │  │
   Claude              │  │ prompt   │    │ (4 callable    │◄─┼──── memory_search
                       │  └──────────┘    │  on demand)    │  │     conversation_search
                       │       │          └────────────────┘  │     recall_persona
                       │       ▼                              │     recall_scenes
                       │  ┌──────────┐                        │
                       │  │ Assistant│                        │
                       │  │ response │                        │
                       │  └──────────┘                        │
                       └──────────┼───────────────────────────┘
                                  │
                                  ▼
                       Stop hook → tencentdb-mem capture
                                  │
                                  ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  <project>/.claude/memory/                                       │
    │                                                                  │
    │  conversations/YYYY-MM-DD.jsonl   ← L0 сырые turn'ы              │
    │  vectors.db                       ← L1 факты (SQLite + vec)      │
    │  scene_blocks/*.md                ← L2 thematic scenes           │
    │  persona.md                       ← L3 coder-профиль             │
    │  .metadata/recall_checkpoint.json ← курсоры + state              │
    └─────────────────▲────────────────────────────────────────────────┘
                      │
                      │  PM2 scheduler (каждые 30 мин) ИЛИ вручную:
                      │      tencentdb-mem extract
                      │
                      └─────────  L0 → L1 → L2 → L3 pipeline
```

### Послойное описание

| Слой | Что хранит | Когда запускается | LLM-расход |
|---|---|---|---|
| **L0** | Сырые `{user, assistant}` turn'ы каждого разговора | После каждого assistant-ответа (Stop hook) | $0 |
| **L1** | Структурированные факты («Kirill использует TS strict», «деплой через PM2») с типом (`persona`/`episodic`/`instruction`) и приоритетом | PM2 tick если есть новые L0 turn'ы; или `tencentdb-mem extract` вручную | ~$0.01-0.05 / tick (Hy3) или ~$0.10-0.30 (Sonnet 4.6) |
| **L2** | Thematic scene Markdown-файлы (например `server-infrastructure-and-deployment.md`), capacity-cap 15, авто-merge при заполнении | Тот же `extract`, после L1 если есть новые факты | ~$0.01-0.02 / tick |
| **L3** | `persona.md` — 8-секционный **coder-профиль** (Stack / Infrastructure / Workflow conventions / Hard rules / Active projects / Communication / Decision patterns / Open) | Когда срабатывает `PersonaTrigger` (cold start, каждые N memories, recovery, explicit request) | ~$0.05-0.15 / регенерация |

**Типичный дневной бюджет**: ~$0.50-2 на LLM-токены в активные дни; копейки в неактивные.

### Изоляция по проектам

У каждого проекта своя `.claude/memory/` директория. Persona для
`~/apps/your-api/` независима от `~/apps/your-frontend/`. Одинаковые
identity-факты (имя, IP сервера, стиль общения) будут пере-извлечены в
каждом проекте — это сделано намеренно, чтобы контексты были чистыми и
независимыми.

---

## L3 заточена под разработчиков (не под общего AI-компаньона)

Tencent оригинально проектировал L3 как «персональный AI-компаньон» — с
секциями Archetype / Texture of Life / Anthropological observations.
Для программирования это бесполезный вес.

В этом форке L3 переписан под **coder-профиль**. На выходе получается
конкретный технический манифест:

```markdown
# Coder Profile

> Last updated: 2026-05-16T...

## Stack
- TypeScript (target 150–300 lines/file, cap 500)
- Python (target 200–400 lines/file, cap 700)
- Node.js (managed via PM2)
- Angie (reverse proxy)

## Infrastructure
- Server IP: 54.37.129.153
- Domain: vechkasov.pro
- DNS provider: Yandex Cloud
- PM2 for process management

## Workflow conventions
- Architectural decisions committed and version-controlled
- Feature planning enforces clean architecture at plan stage
- File plans require single-sentence Responsibility column with no "and"

## Hard rules
- Never allow monolithic files: cap TS 500, Python 700, Vue 600, SQL 200
- Single-responsibility enforcement at naming stage
- Bake quality in early — discipline in tooling, not code review alone

## Active projects
- orchestrator (self-hosted AI orchestration): production deployment
- claude-mem fork: this repo

## Communication preferences
- Russian for explanations, English for code
- Concise, status-first, no ceremony

## Decision patterns
- Quality > cost (infinite budget mode)
- Workflow-as-code over conventions

## Open / pending
- Persona inheritance across projects (deferred until 20+ projects)
```

Никакой воды, никаких «архетипов» — только actionable факты, которые помогают
агенту в работе.

---

## MCP-инструменты (v0.4.2)

После запуска install-скрипта MCP-сервер регистрируется в
`~/.claude.json`, и Claude Code может вызывать эти tool'ы во время
разговора:

| Tool | Что делает |
|---|---|
| `mcp__tencentdb-memory__memory_search` | Поиск L1-фактов по семантической близости (Voyage vector) или keyword fallback. Возвращает top-K матчей. |
| `mcp__tencentdb-memory__conversation_search` | Keyword-поиск по сырым L0 turn'ам. Используется для поиска точного цитирования прошлых обменов. |
| `mcp__tencentdb-memory__recall_persona` | Возвращает полное текущее содержимое persona.md. |
| `mcp__tencentdb-memory__recall_scenes` | Список всех scene-блоков с именами файлов + summaries. |

`MEMORY_TOOLS_GUIDE` (инжектится в системный контекст Claude на каждой сессии)
инструктирует агента вызывать эти tool'ы не более 3 раз за turn и только
когда в prepended-контексте нет нужной информации.

---

## Конфигурация

Поведение каждого проекта управляется через `.claude/memory/config.json`:

```json
{
  "extraction": {
    "enabled": true,
    "model": "deepseek/deepseek-v4-flash"
  },
  "persona": {
    "triggerEveryN": 50,
    "maxScenes": 20,
    "model": "deepseek/deepseek-v4-flash"
  },
  "embedding": {
    "model": "voyage-3-lite",
    "recallTimeoutMs": 1500
  },
  "recall": {
    "topK": 5,
    "scoreThreshold": 0.3
  }
}
```

### Переключение LLM-провайдера

По умолчанию используется `deepseek/deepseek-v4-flash` через OpenRouter (1M контекст, native structured outputs, ~$0.11/M токенов). Если видишь thin extraction (L1 даёт 0 фактов из полных разговоров),
переключи extraction stage на Sonnet 4.6:

```json
"extraction": { "model": "anthropic/claude-sonnet-4.6" }
```

`persona.model` можно задать независимо для L3 — если хочешь разные модели
для L1 и L3.

### Отключение авто-capture

Если хочешь записывать разговоры только вручную:

```json
"capture": { "enabled": false }
```

---

## Ручные команды

```bash
tencentdb-mem init                       # инициализировать .claude/memory/ в cwd
tencentdb-mem capture                    # читать {user, assistant} JSON со stdin → L0
tencentdb-mem recall --query "rate limit" --limit 5
                                         # вывод persona + scene index + L1/L0 матчи
tencentdb-mem recall --no-persona --no-scenes --query "..."
                                         # только матчи (формат v0.3.4)
tencentdb-mem extract                    # запустить L1 → L2 → L3 один раз
tencentdb-mem extract --dry-run          # перечислить сессии без LLM-вызовов
tencentdb-mem extract --max-sessions 1   # обработать максимум N сессий за раз
tencentdb-mem stats                      # статистика базы
tencentdb-mem mcp serve                  # MCP-сервер на stdio (Claude Code вызывает это)
```

---

## Интеграция с оркестратором (опционально)

Если ты используешь task-tracker с командой `task update <id> --status done`,
включи env-переменную:

```bash
export CLAUDE_MEM_TASK_CAPTURE=1
```

После каждой завершённой задачи оркестратор будет спавнить `tencentdb-mem
capture` с синтетическим turn'ом описывающим что было сделано. Будущие
сессии смогут recall'ить `TASK-NNN` и видеть резюме выполнения.

---

## Что сохранено / изменено от upstream Tencent

### Сохранено
- Четырёхслойная архитектура (L0 сырые / L1 факты / L2 сцены / L3 персона)
- SQLite + sqlite-vec для эмбеддингов + FTS5
- jieba CJK-токенизатор (для поиска по китайскому тексту)
- Prompt-injection sanitizer
- Per-session checkpoint state
- Управление capacity сцен с `[DELETED]` soft-delete

### Изменено для этого форка
- **Все LLM-промпты переведены на английский** (в upstream были на китайском)
- **L3 persona переписана как coder-профиль** (Stack / Infra / Workflow / Hard rules — было Archetype / Texture of Life / Anthropological)
- **Добавлен CLI** (upstream был только OpenClaw-plugin); subcommand'ы: `init`, `capture`, `recall`, `extract`, `stats`, `mcp serve`
- **Добавлен MCP-сервер** (4 tool'a)
- **Добавлен PM2 scheduler** для batch-extract
- **SessionStart hook auto-injection** (`<persona-context>` / `<scene-index>`)
- **CheckpointManager L2 cursor persistence** (upstream re-scan'ил каждый run)

### Не портировано (out of scope)
- Tencent Vector DB cloud sync — этот форк local-first
- OpenClaw plugin runtime — заменён на standalone CLI

---

## Troubleshooting

**`tencentdb-mem extract` пишет «OPENROUTER_API_KEY not set»**

Source-ни env-файл в shell или проверь что `~/.claude/claude-mem.env` существует
с режимом 600 и содержит ключ. CLI авто-загружает `~/.claude/claude-mem.env`
дополнительно к shell env.

**Persona.md никогда не обновляется**

Проверь threshold триггера:
`cat .claude/memory/.metadata/recall_checkpoint.json | grep memories_since_last_persona`.
Если меньше `cfg.persona.triggerEveryN` (default 50), L3 не сработает.
Принудительная регенерация: удали `persona.md` и запусти extract заново.

**MCP tool'ы не видны в Claude Code**

Проверь что `~/.claude.json` содержит `mcpServers.tencentdb-memory` с
правильным command path. Перезапусти `install.sh` чтобы исправить, затем
перезапусти Claude Code.

**PM2 scheduler не запускает extract ни в одном проекте**

Проверь что `~/.claude/claude-mem-projects.txt` содержит абсолютные пути
проектов (по одному на строку). Пустой файл = нечего делать.

**Extract выполняется очень долго / таймаутит**

Проверь PM2 kill-таймер в `scheduler.cjs` (`DEFAULT_EXTRACT_TIMEOUT_MS`,
сейчас 15 минут). Понизь если extract быстрый; повысь если в одном проекте
50+ сессий и L3 нужно больше времени.

---

## Статус

| | |
|---|---|
| Версия | 0.5.0 |
| Тесты | 91 проходят |
| Стек | Node 22 · TypeScript · SQLite · Voyage embeddings · OpenRouter |
| Лицензия | MIT (см. [LICENSE](./LICENSE) и [NOTICE.md](./NOTICE.md) для upstream-attribution) |
| Maintainer | [@VKirill](https://github.com/VKirill) |
| Upstream | [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) |

---

## Детальная установка

См. **[INSTALL.md](./INSTALL.md)** — полная пошаговая инструкция включая
prerequisites, получение API-ключей, настройку PM2-демона и проверку.

## Changelog

См. **[CHANGELOG.md](./CHANGELOG.md)** — полная история релизов.

## Contributing

Bug-репорты + PR'ы welcome на https://github.com/VKirill/TencentDB-Memory-Claude-Code.
Большие архитектурные изменения — пожалуйста, сначала открой issue для
обсуждения.
