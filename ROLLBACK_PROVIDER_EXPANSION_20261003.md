# PT•HUB — Rollback antes da expansão de providers

Ponto preservado antes da expansão RTP/TVI/OPTO/Música/Podcasts/Providers oficiais de 03/10/2026.

- Commit exato: `b7a626143dace04ada433318153dd11d5946b805`
- Branch de rollback: `rollback/pre-provider-expansion-20261003`
- Branch de trabalho: `main`

## Voltar exatamente a este ponto

Opção segura, sem apagar o histórico atual:

```bash
git fetch origin
git checkout -B rollback-local origin/rollback/pre-provider-expansion-20261003
```

Para repor a branch main localmente nesse commit apenas se for explicitamente decidido abandonar todas as alterações posteriores:

```bash
git checkout main
git reset --hard b7a626143dace04ada433318153dd11d5946b805
```

Não fazer force-push automaticamente.

Este checkpoint foi criado antes das alterações seguintes:
- expansão RTP Play por hubs/categorias;
- RTP ZigZag, Palco, Podcasts e Desporto;
- reconstrução TVI Player;
- expansão OPTO;
- Jamendo;
- YouTube público;
- hubs de providers oficiais;
- correções de seleção de streamers/Player.pl.
