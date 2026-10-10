/**
 * Creates every collection and index in MongoDB Atlas. Safe to run any number of times.
 *   npm run db:setup -w @nb/api        (reads DATABASE_URL from apps/api/.env)
 * Run it after the first deploy and again whenever schema.prisma gains a @unique / @@unique / @@index.
 * Do NOT use `prisma db push` for the indexes: see prisma/schema-indexes.ts for why.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { buildIndexes, modelNames } from './schema-indexes.js';

const schema = readFileSync(fileURLToPath(new URL('./schema.prisma', import.meta.url)), 'utf8');
const prisma = new PrismaClient();

const codeOf = (e: unknown) => String((e as { message?: string })?.message ?? e);

async function main() {
  // 1) collections (so transactions never have to create one implicitly)
  for (const name of modelNames(schema)) {
    try {
      await prisma.$runCommandRaw({ create: name });
    } catch (e) {
      if (!/already exists|NamespaceExists|\b48\b/.test(codeOf(e))) throw e;
    }
  }

  // 2) indexes
  const specs = buildIndexes(schema);
  let created = 0;
  for (const s of specs) {
    const index = { key: s.key, name: s.name, unique: s.unique, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) };
    try {
      await prisma.$runCommandRaw({ createIndexes: s.collection, indexes: [index] });
      created++;
    } catch (e) {
      // Same name but different options (e.g. a plain unique index left by `prisma db push`): replace it.
      if (/IndexOptionsConflict|IndexKeySpecsConflict|already exists with different options|\b8[56]\b/.test(codeOf(e))) {
        await prisma.$runCommandRaw({ dropIndexes: s.collection, index: s.name });
        await prisma.$runCommandRaw({ createIndexes: s.collection, indexes: [index] });
        created++;
        console.log(`replaced index ${s.collection}.${s.name}`);
      } else {
        throw new Error(`index ${s.collection}.${s.name} failed: ${codeOf(e)}`);
      }
    }
  }
  console.log(`MongoDB ready: ${modelNames(schema).length} collections, ${created} indexes ensured.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
