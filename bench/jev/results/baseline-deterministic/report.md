# Tool-selection benchmark — deterministic baseline

Selector: `deterministic (prefilter + mutation gate, no model)` · cases: 72 · **PASS**

| Metric | Value | Gate |
| --- | --- | --- |
| Required-tool recall (all) | 98.8% (81/82 slots) | — |
| Required-tool recall (mutation cases) | 100.0% (52/52 slots, 37 cases) | must be 100% |
| Forbidden tools selected | 0 | must be 0 |
| Extra tools per case (mean) | 8.04 | — |
| Schema tokens, whole catalog | 34445 | — |
| Schema tokens, selected (mean) | 2064 | — |
| Schema-token reduction | 94.0% | — |
| Selection latency p50 / p95 | 16 ms / 23 ms | — |
| Binary questions asked | 0 | — |
| Deterministic fallbacks | 0 | — |

## Recall by case kind

| Kind | Cases | Slots | Recall |
| --- | --- | --- | --- |
| ambiguous | 12 | 5 | 80.0% |
| multi | 16 | 33 | 100.0% |
| mutation | 20 | 20 | 100.0% |
| single | 24 | 24 | 100.0% |

## Missed slots

| Case | Kind | Request | Missed slot | Selected |
| --- | --- | --- | --- | --- |
| J41 | ambiguous | get the report | drive_search_files \| drive_read_file \| docs_read_document \| sheets_read_range | calendar_get_colors, calendar_get_event, chat_find_direct_message, chat_get_message, chat_get_space, contacts_get_contact, docs_get_document, drive_get_file, gmail_download_attachment, photos_download_media_item |
