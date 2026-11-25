import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_DEFS,
  cardCounts,
  createDeck,
  deckSize,
  preservationThreshold,
  startingHandSize,
  validateDeckKeys,
} from '../src/games/ice/cards.js';
import { settleGame, type SettlementPlayer } from '../src/games/ice/settle.js';
import {
  ICE_CHAOS_GAME,
  ICE_GAME,
  metadataForMode,
  modeForGameId,
} from '../src/games/ice/metadata.js';

function player(
  userId: string,
  identity: SettlementPlayer['identity'],
  accusations: SettlementPlayer['accusations'] = [],
): SettlementPlayer {
  return { userId, name: userId.toUpperCase(), identity, accusations };
}

test('ice deck sizes, hand sizes and preservation thresholds follow the rule table', () => {
  assert.equal(deckSize(3), 18);
  assert.equal(deckSize(4), 24);
  assert.equal(deckSize(5), 25);
  assert.equal(deckSize(6), 24);

  assert.equal(startingHandSize(3), 6);
  assert.equal(startingHandSize(4), 6);
  assert.equal(startingHandSize(5), 5);
  assert.equal(startingHandSize(6), 4);

  assert.equal(preservationThreshold(3), 9);
  assert.equal(preservationThreshold(4), 8);
  assert.equal(preservationThreshold(5), 7);
  assert.equal(preservationThreshold(6), 6);

  const three = cardCounts(3);
  assert.equal(three.accomplice, 0);
  assert.equal(three.honors, 1);
  assert.equal(three.discipline, 1);
  assert.equal(three.ojou, 2);
  assert.equal(three.news, 2);
  assert.equal(three.homebody, 2);

  const five = cardCounts(5);
  assert.equal(five.library, 3);

  const six = cardCounts(6);
  assert.equal(six.library, 2);
  assert.equal(six.accomplice, 1);
});

test('ice deck contains every card exactly once per copy count and unique instance ids', () => {
  for (const playerCount of [3, 4, 5, 6]) {
    const deck = createDeck(playerCount);
    assert.equal(deck.length, deckSize(playerCount));
    assert.equal(new Set(deck.map((card) => card.id)).size, deck.length);
    const keys = deck.map((card) => card.key);
    validateDeckKeys(keys, playerCount);
    const counts = cardCounts(playerCount);
    for (const [key, definition] of Object.entries(CARD_DEFS)) {
      const actual = keys.filter((candidate) => candidate === key).length;
      assert.equal(actual, counts[key as keyof typeof counts], `${playerCount}p ${key}`);
      assert.equal(
        actual,
        definition.variants?.[playerCount] ?? definition.baseCount,
        `${playerCount}p ${key} definition`,
      );
    }
  }
});

test('imprisonment: highest accusation weight, ties imprison everyone at the top, all-equal imprisons nobody', () => {
  const unique = settleGame({
    players: [player('a', 'monitor', ['president']), player('b', 'ojou'), player('c', 'news')],
    preservation: [],
  });
  assert.deepEqual(unique.imprisoned, ['a']);
  assert.deepEqual(
    unique.accusationTotals.map((entry) => entry.total),
    [3, 0, 0],
  );

  const tie = settleGame({
    players: [
      player('a', 'monitor', ['president']),
      player('b', 'ojou', ['monitor', 'discipline']),
      player('c', 'news'),
    ],
    preservation: [],
  });
  assert.deepEqual(tie.imprisoned, ['a', 'b']);

  const allEqual = settleGame({
    players: [player('a', 'monitor', ['alien']), player('b', 'ojou'), player('c', 'news')],
    preservation: [],
  });
  // -1 / 0 / 0: not all equal, so the highest (0) are imprisoned.
  assert.deepEqual(allEqual.imprisoned, ['b', 'c']);

  const trulyEqual = settleGame({
    players: [
      player('a', 'monitor', ['alien']),
      player('b', 'ojou', ['alien']),
      player('c', 'news', ['alien']),
    ],
    preservation: [],
  });
  assert.deepEqual(trulyEqual.imprisoned, []);
});

test('alien wins when imprisoned, regardless of preservation succeeding', () => {
  const result = settleGame({
    players: [
      player('alien', 'alien', ['president']), // 3 -> highest
      player('student', 'monitor', []),
      player('other', 'ojou', []),
    ],
    preservation: ['president', 'monitor', 'honors', 'discipline', 'ojou'],
  });
  assert.equal(result.category, 'alien');
  assert.equal(result.success, true);
  assert.deepEqual(
    result.winners.map((winner) => winner.userId),
    ['alien'],
  );
  assert.match(result.winners[0]!.reason, /被监禁/);
});

test('alien victory is void when no alien holder exists, so lower categories can win', () => {
  const result = settleGame({
    players: [
      player('student', 'monitor', ['president']), // imprisoned, but not an alien
      player('other', 'ojou', []),
      player('third', 'news', []),
    ],
    preservation: ['president', 'monitor', 'honors', 'discipline', 'ojou'],
  });
  // No alien; preservation succeeds; the two students win, the imprisoned
  // monitor is still a student identity and wins too.
  assert.equal(result.category, 'students');
  assert.deepEqual(
    result.winners.map((winner) => winner.userId).sort(),
    ['other', 'student', 'third'],
  );
});

test('infected wins on preservation failure when no alien wins', () => {
  const result = settleGame({
    players: [
      player('infected', 'infected'),
      player('student', 'monitor'),
      player('other', 'ojou'),
    ],
    preservation: ['president', 'monitor', 'honors'], // 3+2+2 = 7 < 9
  });
  assert.equal(result.category, 'infected');
  assert.equal(result.success, false);
  assert.deepEqual(
    result.winners.map((winner) => winner.userId),
    ['infected'],
  );
});

test('alien outranks infected when both conditions are met', () => {
  const result = settleGame({
    players: [
      player('alien', 'alien', ['president']),
      player('infected', 'infected'),
      player('student', 'monitor'),
    ],
    preservation: [],
  });
  assert.equal(result.category, 'alien');
  assert.deepEqual(
    result.winners.map((winner) => winner.userId),
    ['alien'],
  );
});

test('culprit and accomplice win together when the culprit is not imprisoned', () => {
  const result = settleGame({
    players: [
      player('culprit', 'culprit'),
      player('accomplice', 'accomplice'),
      player('student', 'monitor'),
      player('other', 'ojou'),
    ],
    preservation: [],
  });
  assert.equal(result.category, 'culprit');
  assert.deepEqual(
    result.winners.map((winner) => winner.userId).sort(),
    ['accomplice', 'culprit'],
  );
  assert.match(
    result.winners.find((winner) => winner.userId === 'accomplice')!.reason,
    /犯人在场/,
  );
});

test('culprit loses when imprisoned; students then win if preservation succeeded', () => {
  const result = settleGame({
    players: [
      player('culprit', 'culprit', ['president']), // 3 -> imprisoned
      player('accomplice', 'accomplice'),
      player('student', 'monitor'),
      player('other', 'ojou'),
    ],
    preservation: ['president', 'monitor', 'honors', 'discipline', 'library'],
  });
  assert.equal(result.category, 'students');
  assert.deepEqual(
    result.winners.map((winner) => winner.userId).sort(),
    ['other', 'student'],
  );
  assert.deepEqual(result.imprisoned, ['culprit']);
});

test('homebody wins only when nobody else won', () => {
  const result = settleGame({
    players: [
      player('home', 'homebody'),
      player('culprit', 'culprit', ['president']), // imprisoned
      player('student', 'monitor'),
    ],
    preservation: [], // preservation failed
  });
  assert.equal(result.category, 'homebody');
  assert.deepEqual(
    result.winners.map((winner) => winner.userId),
    ['home'],
  );
});

test('everybody can lose when only students remain and preservation failed', () => {
  const result = settleGame({
    players: [
      player('a', 'monitor'),
      player('b', 'ojou'),
      player('c', 'discipline'),
    ],
    preservation: [],
  });
  assert.equal(result.category, 'none');
  assert.deepEqual(result.winners, []);
  assert.equal(result.outcomes.every((outcome) => !outcome.win), true);
  assert.match(result.reason, /全体失败/);
});

test('preservation threshold is inclusive and shown in the result', () => {
  const exact = settleGame({
    players: [player('a', 'monitor'), player('b', 'ojou'), player('c', 'news')],
    preservation: ['president', 'monitor', 'honors', 'discipline', 'ojou'], // 3+2+2+1+1 = 9
  });
  assert.equal(exact.success, true);
  assert.equal(exact.preservationTotal, 9);
  assert.equal(exact.threshold, 9);

  const short = settleGame({
    players: [player('a', 'monitor'), player('b', 'ojou'), player('c', 'news')],
    preservation: ['president', 'monitor', 'honors', 'discipline'], // 8
  });
  assert.equal(short.success, false);
  assert.equal(short.preservationTotal, 8);
});

test('settlement reveals identities and per-player outcomes', () => {
  const result = settleGame({
    players: [
      player('a', 'alien', ['president']),
      player('b', 'monitor', []),
      player('c', 'infected', []),
    ],
    preservation: [],
  });
  assert.deepEqual(
    result.identities.map((identity) => identity.card),
    ['alien', 'monitor', 'infected'],
  );
  const alien = result.outcomes.find((outcome) => outcome.userId === 'a')!;
  const monitor = result.outcomes.find((outcome) => outcome.userId === 'b')!;
  assert.equal(alien.win, true);
  assert.equal(monitor.win, false);
});


test('ice exposes separate standard and chaos game ids', () => {
  assert.equal(ICE_GAME.id, 'ice');
  assert.equal(ICE_CHAOS_GAME.id, 'ice-chaos');
  assert.match(ICE_GAME.name, /标准/);
  assert.match(ICE_CHAOS_GAME.name, /混沌/);
  assert.equal(ICE_GAME.spectatorChat, false);
  assert.equal(ICE_CHAOS_GAME.spectatorChat, false);
  assert.equal(ICE_GAME.minPlayers, 3);
  assert.equal(ICE_CHAOS_GAME.maxPlayers, 6);

  assert.equal(modeForGameId('ice'), 'standard');
  assert.equal(modeForGameId('ice-chaos'), 'chaos');
  assert.equal(modeForGameId('unknown'), null);
  assert.equal(metadataForMode('standard').id, 'ice');
  assert.equal(metadataForMode('chaos').id, 'ice-chaos');
});
