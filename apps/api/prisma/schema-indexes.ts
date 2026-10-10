/**
 * Derives the MongoDB indexes from schema.prisma (pure: no database access, unit tested).
 *
 * Why not `prisma db push`? On MongoDB it creates a plain unique index for every `@unique`, and a
 * unique index treats "field missing" as ONE value, so a second row without the optional value fails.
 * (`Cart.guestToken`, `InventoryItem.optionId`, `Order.idempotencyKey`, ... are optional + unique.)
 * Here an optional unique field gets a PARTIAL unique index that only covers documents where the
 * value is really set, which is what the application expects. Everything else is created as Prisma
 * would create it, with the same index names.
 */

export interface IndexSpec {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique: boolean;
  partialFilterExpression?: Record<string, { $type: string }>;
}

interface Field {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  objectId: boolean;
  unique: boolean;
  isId: boolean;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes']);

export function parseModels(schema: string): Array<{ name: string; fields: Field[]; blockUniques: string[][]; blockIndexes: string[][] }> {
  const out: ReturnType<typeof parseModels> = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields: Field[] = [];
    const blockUniques: string[][] = [];
    const blockIndexes: string[][] = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const bu = line.match(/^@@unique\(\[([^\]]*)\]/);
      if (bu) {
        blockUniques.push(bu[1].split(',').map((x) => x.trim()));
        continue;
      }
      const bi = line.match(/^@@index\(\[([^\]]*)\]/);
      if (bi) {
        blockIndexes.push(bi[1].split(',').map((x) => x.trim()));
        continue;
      }
      if (line.startsWith('@@')) continue;
      const f = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/);
      if (!f) continue;
      const [, name, type, list, optional, rest] = f;
      fields.push({
        name,
        type,
        optional: Boolean(optional),
        list: Boolean(list),
        objectId: rest.includes('@db.ObjectId'),
        unique: /@unique\b/.test(rest),
        isId: /@id\b/.test(rest),
      });
    }
    out.push({ name: m[1], fields, blockUniques, blockIndexes });
  }
  return out;
}

const bsonType = (f: Field) => (f.objectId ? 'objectId' : f.type === 'String' ? 'string' : f.type === 'Int' ? 'int' : f.type === 'DateTime' ? 'date' : f.type === 'Boolean' ? 'bool' : 'string');

export function buildIndexes(schema: string): IndexSpec[] {
  const specs: IndexSpec[] = [];
  for (const model of parseModels(schema)) {
    const byName = new Map(model.fields.map((f) => [f.name, f]));
    const scalar = (n: string) => {
      const f = byName.get(n);
      if (!f) throw new Error(`${model.name}: unknown field "${n}" in an index`);
      if (!SCALARS.has(f.type) && !f.objectId && !/^[A-Z]/.test(f.type)) throw new Error(`${model.name}.${n} is not indexable`);
      return f;
    };
    const keyOf = (names: string[]) => Object.fromEntries(names.map((n) => [n.replace(/\(.*$/, ''), /sort:\s*Desc/i.test(n) ? -1 : 1])) as Record<string, 1 | -1>;
    const clean = (names: string[]) => names.map((n) => n.replace(/\(.*$/, ''));

    for (const f of model.fields) {
      if (!f.unique || f.isId) continue;
      specs.push({
        collection: model.name,
        name: `${model.name}_${f.name}_key`,
        key: { [f.name]: 1 },
        unique: true,
        ...(f.optional ? { partialFilterExpression: { [f.name]: { $type: bsonType(f) } } } : {}),
      });
    }
    for (const names of model.blockUniques) {
      const cols = clean(names);
      const optional = cols.map(scalar).filter((f) => f.optional);
      specs.push({
        collection: model.name,
        name: `${model.name}_${cols.join('_')}_key`,
        key: keyOf(names),
        unique: true,
        ...(optional.length ? { partialFilterExpression: Object.fromEntries(optional.map((f) => [f.name, { $type: bsonType(f) }])) } : {}),
      });
    }
    for (const names of model.blockIndexes) {
      const cols = clean(names);
      cols.forEach(scalar);
      specs.push({ collection: model.name, name: `${model.name}_${cols.join('_')}_idx`, key: keyOf(names), unique: false });
    }
  }
  // one spec per name (a @@index duplicating a @unique is harmless but pointless)
  const seen = new Set<string>();
  return specs.filter((s) => (seen.has(`${s.collection}.${s.name}`) ? false : (seen.add(`${s.collection}.${s.name}`), true)));
}

export const modelNames = (schema: string) => parseModels(schema).map((m) => m.name);
