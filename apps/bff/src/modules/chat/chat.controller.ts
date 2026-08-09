import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { buildSlimPreamble } from '../athlete/context-preamble.js';
import { pipeStreamWithToolExecution, pipeFastPathReply } from './chat.stream.js';
import { compressMessages } from './message-compressor.js';
import { tryMealLogFastPath } from './fast-path-meal-log.js';
import { tryWeightFastPath } from './fast-path-weight.js';
import { db } from '../../db/client.js';
import {
  athletes,
  activities,
  trainingPlans,
  chats,
  chatMessages,
} from '../../db/schema.js';
import { eq, desc, and, asc } from 'drizzle-orm';
import type { ChatMessage } from '../claude/claude.client.js';
import { resolveAthleteId } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/error-handler.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('chat');

export const chatController: Router = Router();
chatController.use(resolveAthleteId);

chatController.get('/suggestions', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;

  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) {
    // A genuine "no athlete yet, so no suggestions" success. A failure must not
    // look like this — which is why the route has no catch of its own: an error
    // reaches jsonErrorHandler and answers 500, not an empty list.
    return res.json({ suggestions: [] });
  }

  const [recentActivity] = await db
    .select({ id: activities.id })
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
    .orderBy(desc(activities.startedAt))
    .limit(1);
  const hasActivities = !!recentActivity;

  const [activePlan] = await db
    .select({ id: trainingPlans.id })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.isActive, true)))
    .limit(1);
  const hasPlan = !!activePlan;

  let suggestions: Array<{ prompt: string }>;

  // No active plan is the strongest signal, regardless of activity
  // history — even an established user with years of synced rides needs
  // a plan built before "what's on today" or "on track this week" mean
  // anything. Treat it like onboarding: one single, focused prompt.
  if (!hasPlan) {
    suggestions = [{ prompt: "I want to build a workout plan" }];
  } else if (hasActivities) {
    suggestions = [
      { prompt: "How was my last workout?" },
      { prompt: "What's in for today?" },
      { prompt: "Am I on track this week?" },
    ];
  } else {
    suggestions = [
      { prompt: "What's in for today?" },
      { prompt: "Am I on track this week?" },
    ];
  }

  res.json({ suggestions });
}));

chatController.get('/chats/:chatId', asyncRoute(async (req: Request, res: Response) => {
  const chatId = String(req.params.chatId);
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.athleteId, req.athleteId)))
    .limit(1);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chat.id))
    .orderBy(asc(chatMessages.createdAt));

  res.json({ ...chat, messages });
}));

chatController.post('/chats', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const incoming: Array<{ role: string; content: string }> = body.messages ?? [];
    const latestUserMessage = [...incoming].reverse().find((m) => m.role === 'user');

    if (!latestUserMessage) {
      return res.status(400).json({ error: 'No user message in request' });
    }

    const athleteId = req.athleteId;

    // Persistence replaces what a prior hosted version's server-side session
    // gave for free — load or create the chat, then load its stored history.
    let chatId = body.chatId && body.chatId !== 'new' ? body.chatId : undefined;
    if (chatId) {
      // A client-supplied chatId must actually belong to this athlete —
      // otherwise this endpoint would happily load and append to any
      // athlete's chat thread just by knowing/guessing its id.
      const [owned] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.athleteId, athleteId)))
        .limit(1);
      if (!owned) return res.status(404).json({ error: 'Chat not found' });
    } else {
      const [newChat] = await db.insert(chats).values({ id: randomUUID(), athleteId }).returning();
      chatId = newChat.id;
    }

    const storedRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.createdAt));

    const history: ChatMessage[] = storedRows.map((r) => ({
      role: r.role as 'user' | 'assistant',
      content: r.content as string | ChatMessage['content'],
    }));

    const newUserMessage: ChatMessage = { role: 'user', content: latestUserMessage.content };

    // Persisted immediately, before generation starts — not batched with the
    // reply at the end. A full turn (tool rounds, specialist consults) can run
    // long enough that a refresh mid-generation used to show the chat as it
    // was before this message existed, because nothing had been written yet.
    await db.insert(chatMessages).values({
      id: randomUUID(),
      chatId,
      role: newUserMessage.role,
      content: newUserMessage.content,
    });

    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Meal logging and weight logging are structured extraction, not reasoning
    // — skip the full Opus orchestrator (two full calls) entirely when a
    // message is purely "I ate X" or "I weigh X," resolved instead with one
    // cheap Haiku call. Meal is checked first; if it handles the message we
    // never call the weight classifier.
    const rawText =
      typeof latestUserMessage.content === 'string' ? latestUserMessage.content : null;

    let fastPath: { handled: false } | { handled: true; confirmationText: string } = {
      handled: false,
    };
    if (rawText) {
      const mealResult = await tryMealLogFastPath(rawText, athleteId);
      fastPath = mealResult.handled ? mealResult : await tryWeightFastPath(rawText, athleteId);
    }

    const producedMessages = fastPath.handled
      ? pipeFastPathReply(res, chatId, fastPath.confirmationText)
      : await pipeStreamWithToolExecution(res, {
          athleteId,
          chatId,
          contextPreamble: await buildSlimPreamble(athleteId),
          messages: compressMessages([...history, newUserMessage]),
        });

    // The user turn is already persisted above. Persist whatever the
    // orchestrator produced (tool round + final answer, or just the final
    // answer if no tools were used) — skipped entirely if producedMessages
    // is empty, which the DB driver would otherwise reject as an empty insert.
    if (producedMessages.length > 0) {
      await db.insert(chatMessages).values(
        producedMessages.map((m) => ({
          id: randomUUID(),
          chatId,
          role: m.role,
          content: m.content,
        })),
      );
    }

    res.end();
  } catch (err) {
    // Kept, unlike the read routes: by this point the SSE headers are usually
    // already out, so jsonErrorHandler's 500 body would be appended to a live
    // event stream. Ending the response is the only correct move.
    log.error('Chat request failed', describeError(err));

    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.end();
    }
  }
});
