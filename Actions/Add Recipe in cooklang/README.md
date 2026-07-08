# Add Recipe in Cooklang

Denne action bruges til at oprette eller renskrive en opskrift som `.cook`-fil i `Recipes/`.

Mappen indeholder:

- `prompt.md`: instruks til opskriftsrobotten.
- `check-content.mjs`: content-check der køres efter nye eller ændrede opskrifter.

## Workflow

1. Brug `prompt.md` til at omskrive kilden til Cooklang.
2. Gem opskriften i den relevante kategori under `Recipes/`.
3. Kør content-check på den nye eller ændrede fil.
4. Opdater datafiler efter behov:
   - `Data/aliases.json`
   - `Data/shoppingAliases.json`
   - `Data/prices.json`
   - `Data/prices/*.json`
   - `Data/ingredientClassifications.json`
5. Kør content-check igen, indtil hårde fejl er væk.

## Kør content-check

Kør fra roden af `Recipes`-repoet:

```bash
node "Actions/Add Recipe in cooklang/check-content.mjs"
```

Tjek en eller flere konkrete opskrifter:

```bash
node "Actions/Add Recipe in cooklang/check-content.mjs" "Recipes/Kød/andesteg.cook"
node "Actions/Add Recipe in cooklang/check-content.mjs" "Recipes/Kød/andesteg.cook" "Recipes/Brød, pizza og dej/crumpets.cook"
```

Vis også info-fund:

```bash
node "Actions/Add Recipe in cooklang/check-content.mjs" --info "Recipes/Kød/andesteg.cook"
```

Skriv rapport som JSON til datarobotten:

```bash
node "Actions/Add Recipe in cooklang/check-content.mjs" --json "Recipes/Kød/andesteg.cook"
```

## Hvad checker scriptet?

Hårde fejl:

- Ingrediens mangler pris efter canonicalisering.
- Enhed kan ikke konverteres til varens basisenhed.

Info-fund:

- Ingrediens har pris, men ingen ingredientTags.
- Ingrediens mangler mængde og kan derfor ikke prisberegnes præcist.

Advarsler:

- Ukendt `category`.
- Manglende frontmatter-felter.
- Ukendt unit alias.
- Ugyldig mængde eller manglende enhed.

## Exit codes

- `0`: Ingen hårde fejl.
- `1`: Mindst én hård fejl.
- `2`: En angivet opskriftsfil findes ikke.

## Princip

Scriptet retter ikke data automatisk. Det finder huller og giver eventuelle forsigtige forslag baseret på eksisterende data, fx plural/singular eller nærliggende unit aliases. Datarobotten eller en udvikler skal derefter opdatere opskrift eller datafiler bevidst.
