# PT•HUB — Nuvio Local Timeshift POC

Estado: EXPERIMENTAL. Não alterar/deployar a `main` do PT•HUB.

## Objetivo

Dar aos canais IPTV Live uma experiência semelhante a uma app de operador, mantendo o stream original intacto:

- pausa/resume;
- recuo curto (10 s / 30 s);
- seek dentro da janela Live disponível;
- botão LIVE para regressar ao direto;
- suporte posterior a catch-up quando a fonte IPTV o disponibilizar.

## Regra de arquitetura

O primeiro protótipo é CLIENT-SIDE no Nuvio/Media3. Não será criado um DVR no Render do PT•HUB nesta fase.

Fluxo:

`IPTV → PT•HUB → Nuvio Media3/ExoPlayer → janela Live/DVR local → UI Timeshift`

O PT•HUB continua a devolver o stream IPTV como atualmente. A `main` não é modificada por esta experiência.

## Fase 1 — Capability detection

Ao iniciar um `channel`, o cliente deve observar a timeline do Media3 e distinguir:

- Live não seekable;
- Live seekable/DVR;
- VOD.

Para Live, usar a janela/timeline reportada pelo player. Só mostrar rewind/seek quando a janela for realmente seekable.

Pseudo-lógica Kotlin:

```kotlin
val timeline = player.currentTimeline
if (!timeline.isEmpty) {
    val window = Timeline.Window()
    timeline.getWindow(player.currentMediaItemIndex, window)

    val isLive = window.isLive
    val canSeek = window.isSeekable

    uiState = uiState.copy(
        isLive = isLive,
        canTimeshift = isLive && canSeek,
        showLiveButton = isLive
    )
}
```

## Fase 2 — Controlos

```kotlin
fun rewind(milliseconds: Long) {
    player.seekTo((player.currentPosition - milliseconds).coerceAtLeast(0L))
}

fun pauseLive() {
    player.pause()
}

fun resumeLive() {
    player.play()
}

fun goLive() {
    player.seekToDefaultPosition()
    player.play()
}
```

UI alvo:

`↶ 30s    ↶ 10min    ❚❚/▶    ● LIVE`

O botão `● LIVE` deve ficar visualmente ativo quando o utilizador estiver junto ao live edge e indicar atraso quando estiver atrás do direto.

## Fase 3 — Buffer local real

Se a origem HLS não disponibilizar uma janela DVR suficientemente longa, a pausa normal do Media3 não garante por si só 30/60 minutos de rewind. Nesse caso, o próximo protótipo deverá acrescentar cache/buffer circular LOCAL no dispositivo, sem alterar o stream do fornecedor nem gravar no Render.

Meta inicial: janela máxima de 30 minutos, configurável, sujeita ao espaço disponível no dispositivo.

## Fase 4 — Xtream catch-up

Quando uma entrada Xtream indicar catch-up/archive, preferir o replay disponibilizado pelo próprio serviço em vez de gravar localmente horas/dias de emissão.

A capacidade deve ser representada separadamente de timeshift local:

- `liveTimeshift`: pausa/rewind da sessão atual;
- `catchup`: programas anteriores disponibilizados pela fonte.

## Critérios do primeiro teste

1. Canal Live continua a abrir normalmente.
2. Sem suporte seekable: comportamento atual não muda.
3. Com Live seekable: pausa funciona.
4. Rewind de 10/30 s funciona dentro da janela disponível.
5. `LIVE` regressa ao live edge.
6. Trocar de canal não bloqueia o player.
7. Nenhuma alteração necessária no `server.js` da produção para este POC.

## Segurança de rollback

Todo o trabalho inicial fica na branch `experimental/nuvio-timeshift`. A branch `main` permanece como baseline de produção PT•HUB 3.1.5.