import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIndexes, modelNames, parseModels } from '../prisma/schema-indexes.js';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const specs = buildIndexes(schema);

describe('MongoDB schema rules', () => {
  it('every model has exactly one id mapped to _id and no composite @@id', () => {
    expect(schema).not.toMatch(/@@id\(/);
    for (const m of parseModels(schema)) {
      expect(m.fields.filter((f) => f.isId).length, m.name).toBe(1);
    }
    for (const block of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const idLine = block[2].split('\n').find((l) => /\s@id\b/.test(l));
      expect(idLine, block[1]).toContain('@map("_id")');
    }
  });

  it('every relation foreign key is an ObjectId', () => {
    for (const block of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      for (const rel of block[2].matchAll(/@relation\(fields: \[([^\]]*)\]/g)) {
        for (const f of rel[1].split(',').map((x) => x.trim())) {
          const line = block[2].split('\n').find((l) => new RegExp(`^\\s*${f}\\s`).test(l));
          expect(line, `${block[1]}.${f}`).toContain('@db.ObjectId');
        }
      }
    }
  });

  it('uses no PostgreSQL-only attributes', () => {
    expect(schema).not.toMatch(/@db\.(?!ObjectId)/);
    expect(schema).not.toMatch(/autoincrement|directUrl|@default\(cuid/);
    expect(schema).toMatch(/provider\s*=\s*"mongodb"/);
  });
});

describe('index builder', () => {
  it('covers every collection and has unique names', () => {
    expect(modelNames(schema).length).toBe(80);
    const names = specs.map((s) => `${s.collection}.${s.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('optional unique fields get partial unique indexes (so many rows may have no value)', () => {
    const partial = Object.fromEntries(specs.filter((s) => s.partialFilterExpression).map((s) => [s.name, s]));
    for (const name of [
      'User_googleId_key',
      'Product_sku_key',
      'CustomizationOption_sku_key',
      'Cart_userId_key',
      'Cart_guestToken_key',
      'GiftMessage_cartId_key',
      'GiftMessage_orderId_key',
      'Order_idempotencyKey_key',
      'InventoryItem_variantId_key',
      'InventoryItem_optionId_key',
    ]) {
      expect(partial[name], name).toBeDefined();
      expect(partial[name].unique).toBe(true);
    }
    expect(partial['Cart_userId_key'].partialFilterExpression).toEqual({ userId: { $type: 'objectId' } });
    expect(partial['Cart_guestToken_key'].partialFilterExpression).toEqual({ guestToken: { $type: 'string' } });
  });

  it('required unique fields stay plain unique indexes, join tables keep their pair unique', () => {
    const byName = new Map(specs.map((s) => [s.name, s]));
    expect(byName.get('User_email_key')).toMatchObject({ unique: true, key: { email: 1 } });
    expect(byName.get('User_email_key')?.partialFilterExpression).toBeUndefined();
    expect(byName.get('UserRole_userId_roleId_key')).toMatchObject({ unique: true, key: { userId: 1, roleId: 1 } });
    expect(byName.get('Cart_userId_key')).toBeDefined();
  });
});
