#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const actionDir = path.dirname(__filename);
const contentRoot = path.resolve(actionDir, "../..");
const dataDir = path.join(contentRoot, "Data");
const recipesDir = path.join(contentRoot, "Recipes");

const knownCategories = new Set([
  "basis",
  "morgenmad",
  "snacks og småretter",
  "forretter",
  "supper",
  "salater",
  "pasta",
  "ris og korn",
  "brød, pizza og dej",
  "sandwich og toast",
  "grønt",
  "fisk og skaldyr",
  "kød",
  "saucer og dressinger",
  "desserter",
  "kager og bagværk",
  "cocktails og drinks",
  "drikke",
  "indkøb og forbrug",
]);

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase("da-DK");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function walkFiles(dir, predicate, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, files);
    } else if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function loadPrices() {
  const manifest = readJson(path.join(dataDir, "prices.json"), {});
  const itemFiles = Array.isArray(manifest.itemFiles) ? manifest.itemFiles : [];
  const splitItems = Object.assign(
    {},
    ...itemFiles.map((itemFile) => {
      const value = readJson(path.join(dataDir, itemFile), {});
      return value.items ?? {};
    }),
  );

  return {
    ...manifest,
    items: normalizePriceItems(manifest.items ?? splitItems),
    unitAliases: normalizeStringRecord(manifest.unitAliases ?? {}),
  };
}

function normalizeStringRecord(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => [normalize(key), normalize(item)]),
  );
}

function normalizePriceItems(items) {
  return Object.fromEntries(
    Object.entries(items ?? {}).map(([key, item]) => {
      if (!item || typeof item !== "object") return [normalize(key), item];

      return [
        normalize(key),
        {
          ...item,
          unit: typeof item.unit === "string" ? normalize(item.unit) : item.unit,
          preferredUnit:
            typeof item.preferredUnit === "string"
              ? normalize(item.preferredUnit)
              : item.preferredUnit,
          conversions: normalizeConversions(item.conversions),
        },
      ];
    }),
  );
}

function normalizeConversions(conversions) {
  if (!conversions || typeof conversions !== "object") return conversions;

  return Object.fromEntries(
    Object.entries(conversions).map(([unit, conversion]) => [
      normalize(unit),
      conversion,
    ]),
  );
}

function invertIngredientAliases(aliases) {
  const inverted = {};

  for (const [canonical, aliasList] of Object.entries(
    aliases.ingredients ?? {},
  )) {
    inverted[normalize(canonical)] = normalize(canonical);

    if (!Array.isArray(aliasList)) continue;

    for (const alias of aliasList) {
      inverted[normalize(alias)] = normalize(canonical);
    }
  }

  return inverted;
}

function loadClassifiedIngredients(classifications) {
  const classified = new Set();

  for (const tag of Object.values(classifications.ingredientTags ?? {})) {
    if (!Array.isArray(tag.ingredients)) continue;

    for (const ingredient of tag.ingredients) {
      classified.add(normalize(ingredient));
    }
  }

  return classified;
}

function parseFrontmatter(source) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const metadata = {};

  if (!match) return metadata;

  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);

    if (!item) continue;

    metadata[item[1]] = item[2].replace(/^["']|["']$/g, "");
  }

  return metadata;
}

function parseIngredientAmount(amount) {
  const trimmed = amount.trim();

  if (!trimmed) {
    return {
      quantity: undefined,
      unit: undefined,
    };
  }

  const separator = trimmed.indexOf("%");

  if (separator === -1) {
    return {
      quantity: trimmed,
      unit: undefined,
    };
  }

  return {
    quantity: trimmed.slice(0, separator).trim() || undefined,
    unit: trimmed.slice(separator + 1).trim() || undefined,
  };
}

function parseIngredients(source) {
  const ingredients = [];
  const regex = /@([^{\n]+)\{([^}]*)\}/g;

  for (const match of source.matchAll(regex)) {
    const rawName = match[1].trim();

    if (rawName.startsWith("./") || rawName.startsWith("../")) continue;

    const amount = parseIngredientAmount(match[2]);

    ingredients.push({
      rawName,
      normalizedName: normalize(rawName),
      ...amount,
    });
  }

  return ingredients;
}

function parseQuantity(value) {
  if (!value) return undefined;

  const normalized = value.trim().replace(",", ".");
  const rangeMatch = normalized.match(
    /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/,
  );

  if (rangeMatch) {
    return (Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2;
  }

  const fractionMatch = normalized.match(/^(\d+)\s*\/\s*(\d+)$/);

  if (fractionMatch) {
    const denominator = Number(fractionMatch[2]);
    return denominator === 0 ? undefined : Number(fractionMatch[1]) / denominator;
  }

  const mixedFractionMatch = normalized.match(
    /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/,
  );

  if (mixedFractionMatch) {
    const denominator = Number(mixedFractionMatch[3]);
    return denominator === 0
      ? undefined
      : Number(mixedFractionMatch[1]) +
          Number(mixedFractionMatch[2]) / denominator;
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeUnit(unit, prices) {
  if (!unit) return undefined;

  const normalized = normalize(unit);

  return prices.unitAliases[normalized] ?? normalized;
}

function getConversion(rawUnit, priceItem, prices) {
  if (!rawUnit || !priceItem?.conversions) return undefined;

  const rawKey = normalize(rawUnit);
  const normalizedKey = normalizeUnit(rawUnit, prices);

  return priceItem.conversions[rawKey] ?? priceItem.conversions[normalizedKey];
}

function canConvert({ quantity, rawUnit, priceUnit, conversion, prices }) {
  if (!rawUnit || quantity == null) return false;

  const unit = normalize(rawUnit);
  const normalizedUnit = normalizeUnit(rawUnit, prices);
  const weightFactorToKg = { g: 1 / 1000, kg: 1 };
  const volumeFactorToLiter = {
    ml: 1 / 1000,
    cl: 1 / 100,
    dl: 1 / 10,
    l: 1,
    liter: 1,
  };

  if (unit === priceUnit || normalizedUnit === priceUnit) return true;
  if (priceUnit === "kg" && weightFactorToKg[unit] != null) return true;
  if (priceUnit === "liter" && volumeFactorToLiter[unit] != null) return true;
  if (priceUnit === "kg" && conversion?.grams != null) return true;
  if (priceUnit === "liter" && conversion?.milliliters != null) return true;
  if (priceUnit === "stk" && conversion?.units != null) return true;

  return false;
}

function getPriceName(canonicalName, prices, shoppingAliases) {
  if (prices.items[canonicalName]) {
    return {
      name: canonicalName,
      viaShoppingAlias: false,
    };
  }

  const shoppingName = shoppingAliases.ingredients?.[canonicalName];

  return {
    name: normalize(shoppingName ?? canonicalName),
    viaShoppingAlias: Boolean(shoppingName),
  };
}

function compactPluralCandidates(value, candidates) {
  const normalized = normalize(value);
  const variants = new Set([
    normalized.replace(/er$/, ""),
    normalized.replace(/r$/, ""),
    normalized.replace(/e$/, ""),
    normalized.replace(/der$/, "d"),
    normalized.replace(/ter$/, "t"),
    normalized.replace(/øer$/, "ø"),
    normalized.replace(/aa/g, "å"),
    normalized.replace(/\s+/g, "-"),
    normalized.replace(/-/g, " "),
  ]);

  return [...variants].filter(
    (variant) => variant && variant !== normalized && candidates.has(variant),
  );
}

function addIssue(issues, severity, kind, recipePath, message, details = {}) {
  issues.push({
    severity,
    kind,
    recipe: recipePath,
    message,
    ...details,
  });
}

function addRecipeIssue(
  issues,
  seenIssues,
  severity,
  kind,
  recipePath,
  message,
  details = {},
) {
  const key = [
    kind,
    details.canonicalName ?? "",
    details.ingredient ?? "",
    details.unit ?? "",
    details.quantity ?? "",
  ].join("::");

  if (seenIssues.has(key)) return;

  seenIssues.add(key);
  addIssue(issues, severity, kind, recipePath, message, details);
}

function checkRecipe({
  filePath,
  aliases,
  prices,
  shoppingAliases,
  classifiedIngredients,
}) {
  const source = fs.readFileSync(filePath, "utf8");
  const relativePath = path.relative(contentRoot, filePath);
  const metadata = parseFrontmatter(source);
  const ingredients = parseIngredients(source);
  const issues = [];
  const seenIssues = new Set();

  if (!metadata.title) {
    addIssue(issues, "warning", "metadata", relativePath, "Mangler title.");
  }

  if (!metadata.category) {
    addIssue(issues, "warning", "metadata", relativePath, "Mangler category.");
  } else if (!knownCategories.has(normalize(metadata.category))) {
    addIssue(
      issues,
      "warning",
      "metadata",
      relativePath,
      `Ukendt category: ${metadata.category}.`,
    );
  }

  for (const ingredient of ingredients) {
    const canonicalName =
      aliases[ingredient.normalizedName] ?? ingredient.normalizedName;
    const priceMatch = getPriceName(canonicalName, prices, shoppingAliases);
    const priceItem = prices.items[priceMatch.name];

    if (!priceItem) {
      const candidates = compactPluralCandidates(
        canonicalName,
        new Set(Object.keys(prices.items)),
      );

      addRecipeIssue(
        issues,
        seenIssues,
        "error",
        "missing-price",
        relativePath,
        `${ingredient.rawName}: mangler pris for canonical "${canonicalName}".`,
        {
          ingredient: ingredient.rawName,
          canonicalName,
          suggestions: candidates.map((candidate) => ({
            type: "possible-price-name",
            value: candidate,
          })),
        },
      );

      continue;
    }

    if ("recipe" in priceItem) {
      continue;
    }

    const shouldCheckClassification =
      priceItem.price !== 0 && priceItem.pantry !== true;

    if (shouldCheckClassification && !classifiedIngredients.has(canonicalName)) {
      const classificationCandidates = compactPluralCandidates(
        canonicalName,
        classifiedIngredients,
      );

      addRecipeIssue(
        issues,
        seenIssues,
        "info",
        "missing-classification",
        relativePath,
        `${ingredient.rawName}: har pris, men ingen ingredientTags.`,
        {
          ingredient: ingredient.rawName,
          canonicalName,
          suggestions: classificationCandidates.map((candidate) => ({
            type: "possible-classification-name",
            value: candidate,
          })),
        },
      );
    }

    if (!ingredient.quantity) {
      if (priceItem.pantry !== true) {
        addRecipeIssue(
          issues,
          seenIssues,
          "info",
          "missing-quantity",
          relativePath,
          `${ingredient.rawName}: mangler mængde og kan ikke prisberegnes præcist.`,
          {
            ingredient: ingredient.rawName,
            canonicalName,
          },
        );
      }

      continue;
    }

    const quantity = parseQuantity(ingredient.quantity);

    if (quantity == null) {
      addRecipeIssue(
        issues,
        seenIssues,
        "warning",
        "invalid-quantity",
        relativePath,
        `${ingredient.rawName}: mængden "${ingredient.quantity}" kan ikke læses som tal.`,
        {
          ingredient: ingredient.rawName,
          canonicalName,
          quantity: ingredient.quantity,
        },
      );

      continue;
    }

    if (!ingredient.unit) {
      addRecipeIssue(
        issues,
        seenIssues,
        "warning",
        "missing-unit",
        relativePath,
        `${ingredient.rawName}: har mængde "${ingredient.quantity}", men ingen enhed.`,
        {
          ingredient: ingredient.rawName,
          canonicalName,
          quantity: ingredient.quantity,
        },
      );

      continue;
    }

    const priceUnit = normalizeUnit(priceItem.unit, prices);
    const rawUnit = normalize(ingredient.unit);
    const normalizedUnit = normalizeUnit(ingredient.unit, prices);
    const conversion = getConversion(ingredient.unit, priceItem, prices);

    if (!prices.unitAliases[rawUnit] && rawUnit !== priceUnit) {
      const candidates = compactPluralCandidates(
        rawUnit,
        new Set(Object.keys(prices.unitAliases)),
      );

      addRecipeIssue(
        issues,
        seenIssues,
        "warning",
        "unknown-unit-alias",
        relativePath,
        `${ingredient.rawName}: enheden "${ingredient.unit}" findes ikke i unitAliases.`,
        {
          ingredient: ingredient.rawName,
          canonicalName,
          unit: ingredient.unit,
          suggestions: candidates.map((candidate) => ({
            type: "possible-unit-alias",
            value: candidate,
          })),
        },
      );
    }

    if (
      !canConvert({
        quantity,
        rawUnit: ingredient.unit,
        priceUnit,
        conversion,
        prices,
      })
    ) {
      addRecipeIssue(
        issues,
        seenIssues,
        "error",
        "missing-conversion",
        relativePath,
        `${ingredient.rawName}: kan ikke konvertere "${ingredient.unit}" til prisens basisenhed "${priceUnit}".`,
        {
          ingredient: ingredient.rawName,
          canonicalName,
          unit: ingredient.unit,
          normalizedUnit,
          priceUnit,
        },
      );
    }
  }

  return {
    file: relativePath,
    ingredientCount: ingredients.length,
    issues,
  };
}

function resolveRecipePath(input) {
  if (path.isAbsolute(input)) return input;

  const fromContentRoot = path.resolve(contentRoot, input);
  if (fs.existsSync(fromContentRoot)) return fromContentRoot;

  const fromRecipesDir = path.resolve(recipesDir, input);
  if (fs.existsSync(fromRecipesDir)) return fromRecipesDir;

  return fromContentRoot;
}

function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    includeInfo: false,
    files: [],
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--info") {
      options.includeInfo = true;
    } else {
      options.files.push(arg);
    }
  }

  return options;
}

function printHelp() {
  console.log(`CONTENT CHECK

Brug:
  node "Actions/Add Recipe in cooklang/check-content.mjs"
  node "Actions/Add Recipe in cooklang/check-content.mjs" "Recipes/Kød/andesteg.cook"
  node "Actions/Add Recipe in cooklang/check-content.mjs" --info "Recipes/Kød/andesteg.cook"
  node "Actions/Add Recipe in cooklang/check-content.mjs" --json "Recipes/Kød/andesteg.cook"

Options:
  --info   Vis også info-fund som manglende klassifikation og manglende mængde.
  --json   Skriv hele rapporten som JSON til datarobotten eller scripts.
  --help   Vis denne hjælp.

Exit code:
  0        Ingen hårde fejl.
  1        Mindst én hård fejl, fx manglende pris eller conversion.
  2        En angivet opskriftsfil findes ikke.
`);
}

function groupIssues(issues) {
  return issues.reduce((groups, issue) => {
    groups[issue.kind] ??= [];
    groups[issue.kind].push(issue);
    return groups;
  }, {});
}

function labelForKind(kind) {
  return (
    {
      "missing-price": "Mangler pris",
      "missing-conversion": "Mangler conversion",
      "unknown-unit-alias": "Ukendt unit alias",
      "missing-classification": "Mangler klassifikation",
      "missing-quantity": "Mangler mængde",
      "missing-unit": "Mangler enhed",
      "invalid-quantity": "Ugyldig mængde",
      metadata: "Metadata",
    }[kind] ?? kind
  );
}

function printTextReport(report, options) {
  const counts = report.summary;
  const visibleIssues = options.includeInfo
    ? report.issues
    : report.issues.filter((issue) => issue.severity !== "info");

  console.log("CONTENT CHECK");
  console.log("");
  console.log(`Opskrifter tjekket: ${counts.recipes}`);
  console.log(`Ingredienser tjekket: ${counts.ingredients}`);
  console.log(`Fejl: ${counts.errors}`);
  console.log(`Advarsler: ${counts.warnings}`);
  console.log(`Info: ${counts.info}`);

  if (!options.includeInfo && counts.info > 0) {
    console.log(`Info skjult: ${counts.info} (brug --info for at vise dem)`);
  }

  if (visibleIssues.length === 0) {
    console.log("");
    console.log(
      report.issues.length === 0
        ? "Ingen fund."
        : "Ingen fejl eller advarsler.",
    );
    return;
  }

  const grouped = groupIssues(visibleIssues);

  for (const [kind, issues] of Object.entries(grouped)) {
    console.log("");
    console.log(labelForKind(kind).toLocaleUpperCase("da-DK"));

    for (const issue of issues) {
      console.log(`- ${issue.recipe}`);
      console.log(`  ${issue.message}`);

      if (issue.suggestions?.length > 0) {
        console.log(
          `  Muligt forslag: ${issue.suggestions
            .map((suggestion) => suggestion.value)
            .join(", ")}`,
        );
      }
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const aliases = invertIngredientAliases(
    readJson(path.join(dataDir, "aliases.json"), { ingredients: {} }),
  );
  const shoppingAliases = readJson(path.join(dataDir, "shoppingAliases.json"), {
    ingredients: {},
  });
  const prices = loadPrices();
  const classifications = readJson(
    path.join(dataDir, "ingredientClassifications.json"),
    { ingredientTags: {} },
  );
  const classifiedIngredients = loadClassifiedIngredients(classifications);
  const files =
    options.files.length > 0
      ? options.files.map(resolveRecipePath)
      : walkFiles(recipesDir, (filePath) => filePath.endsWith(".cook")).sort();

  const missingFiles = files.filter((filePath) => !fs.existsSync(filePath));

  if (missingFiles.length > 0) {
    console.error("Følgende opskriftsfiler findes ikke:");
    for (const filePath of missingFiles) {
      console.error(`- ${path.relative(contentRoot, filePath)}`);
    }
    process.exit(2);
  }

  const recipeReports = files.map((filePath) =>
    checkRecipe({
      filePath,
      aliases,
      prices,
      shoppingAliases,
      classifiedIngredients,
    }),
  );
  const issues = recipeReports.flatMap((recipeReport) => recipeReport.issues);
  const report = {
    summary: {
      recipes: recipeReports.length,
      ingredients: recipeReports.reduce(
        (total, recipeReport) => total + recipeReport.ingredientCount,
        0,
      ),
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
    },
    issues,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report, options);
  }

  process.exitCode = report.summary.errors > 0 ? 1 : 0;
}

main();
