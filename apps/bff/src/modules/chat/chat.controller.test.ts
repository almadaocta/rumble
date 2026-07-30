// Regression tests for a real bug found and fixed in this codebase: both
// GET /chats/:chatId and POST /chats (with a client-supplied chatId) used to
// look up a chat by id alone, with no check that it belonged to the
// requesting athlete — any athlete could read or append to any other
// athlete's chat just by knowing/guessing its id.
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { chats } from '../../db/schema.js';
import { chatController } from './chat.controller.js';

// Injects req.athleteId directly, simulating "this request is authenticated
// as <athleteId>" — resolveAthleteId (mounted inside chatController) is
// idempotent and won't override an already-set value, which is exactly what
// lets tests act as two different athletes without real multi-user auth
// existing yet.
function buildTestApp(athleteId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.athleteId = athleteId;
    next();
  });
  app.use('/api/chat', chatController);
  return app;
}

describe('chat.controller cross-tenant isolation', () => {
  let athleteA: string;
  let athleteB: string;
  let athleteAChatId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteA = await seedAthlete('Athlete A');
    athleteB = await seedAthlete('Athlete B');

    const [chat] = await db.insert(chats).values({ id: randomUUID(), athleteId: athleteA }).returning();
    athleteAChatId = chat.id;
  });

  it('lets athlete A read their own chat', async () => {
    const res = await request(buildTestApp(athleteA)).get(`/api/chat/chats/${athleteAChatId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(athleteAChatId);
  });

  it("404s when athlete B tries to GET athlete A's chat", async () => {
    const res = await request(buildTestApp(athleteB)).get(`/api/chat/chats/${athleteAChatId}`);
    expect(res.status).toBe(404);
  });

  it("404s when athlete B tries to POST into athlete A's chat (not just read it)", async () => {
    const res = await request(buildTestApp(athleteB))
      .post('/api/chat/chats')
      .send({ chatId: athleteAChatId, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(404);
  });

  it('404s for a chatId that belongs to no one', async () => {
    const res = await request(buildTestApp(athleteA)).get(`/api/chat/chats/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
