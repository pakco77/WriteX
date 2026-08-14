import assert from "node:assert/strict";
import test from "node:test";
import {
  validateThemePackage,
  type WriteXThemePackage,
} from "../src/themeSchema.ts";

function validTheme(): WriteXThemePackage {
  return {
    schemaVersion: 1,
    manifest: {
      id: "pakco.test",
      name: "Test",
      version: "1.0.0",
      author: "Pakco",
      license: "MIT",
      sourceUrl: "https://example.com/theme",
      description: "Test theme",
      minWriteXVersion: "0.4.0",
    },
    tokens: {},
    components: {
      document: { template: "<section>{{children}}</section>" },
      paragraph: { template: "<p>{{children}}</p>" },
    },
    mapping: {
      document: "document",
      paragraph: "paragraph",
    },
  };
}

test("a minimal v1 theme package is accepted", () => {
  const result = validateThemePackage(validTheme());
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.theme?.manifest.id, "pakco.test");
});

test("theme limits reject oversized, too many components, and deep nesting", () => {
  const oversized = validTheme();
  oversized.manifest.description = "x".repeat(2 * 1024 * 1024);

  const crowded = validTheme();
  crowded.components = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`component-${index}`, { template: "<p>{{content}}</p>" }]),
  );

  const deep = validTheme();
  deep.components.paragraph.template = `${"<section>".repeat(21)}{{children}}${"</section>".repeat(21)}`;

  assert.match(validateThemePackage(oversized).errors.join("\n"), /2 MiB/);
  assert.match(validateThemePackage(crowded).errors.join("\n"), /128/);
  assert.match(validateThemePackage(deep).errors.join("\n"), /20/);
});

test("ids, versions, mapping targets, and placeholders are bounded", () => {
  const unsafeId = validTheme();
  unsafeId.manifest.id = "../escape";

  const badVersion = validTheme();
  badVersion.manifest.version = "latest";

  const unknownComponent = validTheme();
  unknownComponent.mapping.paragraph = "missing";

  const secretPlaceholder = validTheme();
  secretPlaceholder.components.paragraph.template = "<p>{{secret}}</p>";

  assert.equal(validateThemePackage(unsafeId).ok, false);
  assert.equal(validateThemePackage(badVersion).ok, false);
  assert.equal(validateThemePackage(unknownComponent).ok, false);
  assert.equal(validateThemePackage(secretPlaceholder).ok, false);
});

test("templates reject executable HTML, unsafe attributes, CSS, protocols, and placeholder locations", () => {
  const rejected = [
    '<script>alert(1)</script>',
    '<style>p{color:red}</style>',
    '<section class="x">{{children}}</section>',
    '<section id="x">{{children}}</section>',
    '<section onclick="x()">{{children}}</section>',
    '<iframe src="https://example.com"></iframe>',
    '<a href="javascript:alert(1)">{{content}}</a>',
    '<section style="background:url(https://tracker.example/x)">{{children}}</section>',
    '<section style="position:absolute">{{children}}</section>',
    '<section style="display:grid">{{children}}</section>',
    '<section style="animation:x 1s">{{children}}</section>',
    '<section style="transform:scale(2)">{{children}}</section>',
    '<img src="{{children}}">',
  ];

  for (const template of rejected) {
    const theme = validTheme();
    theme.components.paragraph.template = template;
    assert.equal(validateThemePackage(theme).ok, false, `should reject ${template}`);
  }
});

test("templates accept the conservative inline WeChat subset", () => {
  const theme = validTheme();
  theme.components.paragraph.template = [
    '<section style="display:flex; color:rgb(89, 89, 89); background:linear-gradient(90deg, #fff, #eee); font-family:-apple-system, BlinkMacSystemFont, sans-serif">',
    '<p leaf=""><span>{{content}}</span><a href="{{src}}" title="link">{{content}}</a></p>',
    '<table cellpadding="0" cellspacing="0" border="0"><thead><tr><th colspan="2">{{content}}</th></tr></thead><tbody><tr><td rowspan="1">{{children}}</td></tr></tbody></table>',
    '<img src="{{src}}" alt="{{alt}}"><br><hr>',
    '</section>',
  ].join("");

  const result = validateThemePackage(theme);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("corruption corpus rejects malformed tags, unquoted values, CSS escapes and disguised protocols", () => {
  const rejected = [
    "<section><p>{{children}}</section></p>",
    "<section style=color:red>{{children}}</section>",
    '<section style="background:u\\72l(https://tracker.example/x)">{{children}}</section>',
    '<SCRIPT>{{children}}</SCRIPT>',
    '<section OnClick="evil()">{{children}}</section>',
    '<a href="java\u0000script:alert(1)">{{content}}</a>',
    '<a href=" java\nscript:alert(1) ">{{content}}</a>',
    '<section>{{{{children}}}}</section>',
    '<img alt="prefix {{alt}}" src="{{src}}">',
  ];
  for (const template of rejected) {
    const theme = validTheme();
    theme.components.paragraph.template = template;
    assert.equal(validateThemePackage(theme).ok, false, `should reject ${JSON.stringify(template)}`);
  }
});
