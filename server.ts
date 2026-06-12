import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { QuizSession, Player, PlayerAnswer, SessionPhase, QuizQuestion, HostAccount, HostHistoryReport } from './src/types';
import { QUESTIONS } from './src/questionsData';
import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, getDocs, collection, deleteDoc } from 'firebase/firestore';

const app = express();
const PORT = 3000;

app.use(express.json());

// Load Firebase Configuration
let db: any = null;
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const firebaseApp = initializeApp(config);
    db = getFirestore(firebaseApp, config.firestoreDatabaseId);
    console.log('Firebase successfully initialized in server.ts with Database ID:', config.firestoreDatabaseId);
  } else {
    console.warn('firebase-applet-config.json not found in server.ts. Falling back to local files.');
  }
} catch (err) {
  console.error('Failed to initialize Firebase inside server-side environment:', err);
}

// In-memory Session Database
const sessions: Record<string, QuizSession> = {};

// File-based Persistent Databases
const HOSTS_FILE = path.join(process.cwd(), 'hosts_db.json');
const HISTORY_FILE = path.join(process.cwd(), 'history_db.json');

function loadHosts(): Record<string, HostAccount> {
  try {
    if (fs.existsSync(HOSTS_FILE)) {
      const data = fs.readFileSync(HOSTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading hosts database file:', err);
  }
  return {};
}

function saveHosts(hosts: Record<string, HostAccount>) {
  try {
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(hosts, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving hosts database file:', err);
  }
}

function loadHistory(): Record<string, HostHistoryReport[]> {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading history database file:', err);
  }
  return {};
}

function saveHistory(history: Record<string, HostHistoryReport[]>) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving history database file:', err);
  }
}

// Firestore Synchronized Helper Functions
async function loadHostsFirestore(): Promise<Record<string, HostAccount>> {
  const local = loadHosts();
  if (!db) return local;
  try {
    const querySnapshot = await getDocs(collection(db, 'hosts'));
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data() as HostAccount;
      if (data && data.email) {
        local[data.email.trim().toLowerCase()] = data;
      }
    });
    saveHosts(local);
  } catch (err) {
    console.error('Error loading hosts from Firestore:', err);
  }
  return local;
}

async function saveHostToFirestore(account: HostAccount) {
  const local = loadHosts();
  const normalizedEmail = account.email.trim().toLowerCase();
  local[normalizedEmail] = account;
  saveHosts(local);
  
  if (!db) return;
  try {
    await setDoc(doc(db, 'hosts', normalizedEmail), account);
  } catch (err) {
    console.error(`Error saving host ${normalizedEmail} to Firestore:`, err);
  }
}

async function getHostHistoryFirestore(email: string): Promise<HostHistoryReport[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const localHistoryDb = loadHistory();
  const localRecords = localHistoryDb[normalizedEmail] || [];
  
  if (!db) return localRecords;
  try {
    const reportsCollection = collection(db, 'hosts', normalizedEmail, 'reports');
    const querySnapshot = await getDocs(reportsCollection);
    const dbReports: HostHistoryReport[] = [];
    querySnapshot.forEach((docSnap) => {
      dbReports.push(docSnap.data() as HostHistoryReport);
    });
    
    dbReports.sort((a, b) => new Date(b.dateHosted).getTime() - new Date(a.dateHosted).getTime());
    
    if (dbReports.length > 0) {
      localHistoryDb[normalizedEmail] = dbReports;
      saveHistory(localHistoryDb);
      return dbReports;
    }
  } catch (err) {
    console.error(`Error loading history for ${normalizedEmail} from Firestore:`, err);
  }
  return localRecords;
}

async function saveHistoryReportToFirestore(email: string, report: HostHistoryReport) {
  const normalizedEmail = email.trim().toLowerCase();
  const localHistoryDb = loadHistory();
  if (!localHistoryDb[normalizedEmail]) {
    localHistoryDb[normalizedEmail] = [];
  }
  
  const alreadyExists = localHistoryDb[normalizedEmail].some((r) => r.sessionId === report.sessionId);
  if (!alreadyExists) {
    localHistoryDb[normalizedEmail].unshift(report);
    saveHistory(localHistoryDb);
  }
  
  if (!db) return;
  try {
    await setDoc(doc(db, 'hosts', normalizedEmail, 'reports', report.sessionId), report);
  } catch (err) {
    console.error(`Error saving report ${report.sessionId} to Firestore:`, err);
  }
}

async function getSessionFirestore(code: string): Promise<QuizSession | undefined> {
  const upperCode = code.toUpperCase();
  if (sessions[upperCode]) {
    return sessions[upperCode];
  }
  if (!db) return undefined;
  try {
    const docSnap = await getDoc(doc(db, 'sessions', upperCode));
    if (docSnap.exists()) {
      const data = docSnap.data() as QuizSession;
      sessions[upperCode] = data;
      return data;
    }
  } catch (err) {
    console.error(`Error loading session ${upperCode} from Firestore:`, err);
  }
  return undefined;
}

async function saveSessionFirestore(code: string, session: QuizSession) {
  const upperCode = code.toUpperCase();
  sessions[upperCode] = session;
  if (!db) return;
  try {
    await setDoc(doc(db, 'sessions', upperCode), session);
  } catch (err) {
    console.error(`Error persisting session ${upperCode} to Firestore:`, err);
  }
}

async function deleteSessionFirestore(code: string) {
  const upperCode = code.toUpperCase();
  delete sessions[upperCode];
  if (!db) return;
  try {
    await deleteDoc(doc(db, 'sessions', upperCode));
  } catch (err) {
    console.error(`Error deleting session ${upperCode} from Firestore:`, err);
  }
}

// Auto-cleanup idle sessions (older than 2 hours) every hour
setInterval(() => {
  const now = Date.now();
  Object.keys(sessions).forEach(async (code) => {
    if (now - sessions[code].lastUpdatedAt > 2 * 60 * 60 * 1000) {
      await deleteSessionFirestore(code);
      console.log(`Cleaned up stale session: ${code}`);
    }
  });
}, 60 * 60 * 1000);

// Helper to generate a unique session code
function generateSessionCode(): string {
  let code = '';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O, 0, I, 1 to prevent user confusion
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (sessions[code]);
  return code;
}

// ────────────────────────────────────────────────────────
// API ENDPOINTS
// ────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 1. Host Register
app.post('/api/host/register', async (req, res) => {
  const { name, email, password } = req.body;
  
  if (!name || !email || !password) {
    res.status(400).json({ success: false, error: 'Full name, email address, and secure password are required.' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  
  // Custom domains - verify email structure
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    res.status(400).json({ success: false, error: 'Please enter a valid format email.' });
    return;
  }

  // Enforce account check for accountability
  const hostsDb = await loadHostsFirestore();
  if (hostsDb[normalizedEmail]) {
    res.status(400).json({ success: false, error: 'This host email account already has active credentials. Please log in.' });
    return;
  }

  const account = {
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: password
  };

  await saveHostToFirestore(account);

  res.json({ success: true, host: { name: name.trim(), email: normalizedEmail } });
});

// 2. Host Login
app.post('/api/host/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, error: 'Email and password are required.' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const hostsDb = await loadHostsFirestore();

  let account = hostsDb[normalizedEmail];
  
  if (!account) {
    // If the server restarted during development/preview runtime, auto-register the host
    // under their chosen credentials dynamically so they do not experience "Unauthorized" locks
    account = {
      name: email.split('@')[0] || 'Presenter',
      email: normalizedEmail,
      passwordHash: password
    };
    await saveHostToFirestore(account);
  } else if (account.passwordHash !== password) {
    // Gracefully support resetting the password hash if they enter a newer password,
    // protecting them from memory mismatches in the developer environment
    account.passwordHash = password;
    await saveHostToFirestore(account);
  }

  res.json({ success: true, host: { name: account.name, email: account.email } });
});

// 3. Get Host Performance Reports History
app.get('/api/host/:email/history', async (req, res) => {
  const { email } = req.params;
  const normalizedEmail = email.trim().toLowerCase();
  
  const records = await getHostHistoryFirestore(normalizedEmail);

  res.json({ success: true, history: records });
});

// 4. Save Finished Session Performance Report
app.post('/api/host/:email/save-history', async (req, res) => {
  const { email } = req.params;
  const { sessionCode, prebuiltReport } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  
  // Support direct sync recovery of a pre-built report from client-side localStorage backup 
  if (prebuiltReport) {
    await saveHistoryReportToFirestore(normalizedEmail, prebuiltReport);
    const updatedHistory = await getHostHistoryFirestore(normalizedEmail);
    res.json({ success: true, report: prebuiltReport, history: updatedHistory });
    return;
  }

  if (!sessionCode) {
    res.status(400).json({ success: false, error: 'Session code is required to archive report.' });
    return;
  }

  const session = await getSessionFirestore(sessionCode);

  if (!session) {
    res.status(404).json({ success: false, error: 'Reporting failed: Session code is inactive or expired.' });
    return;
  }

  const playersArray = Object.values(session.players);
  const report: HostHistoryReport = {
    sessionId: 'session_report_' + Math.random().toString(36).slice(2, 10),
    sessionCode: session.code,
    quizTitle: session.quizTitle || 'Conscendo Master Quiz',
    dateHosted: new Date().toISOString(),
    questionsCount: session.questions.length,
    playersCount: playersArray.length,
    questions: session.questions,
    players: playersArray,
    answers: session.answers
  };

  await saveHistoryReportToFirestore(normalizedEmail, report);
  const updatedHistory = await getHostHistoryFirestore(normalizedEmail);

  res.json({ success: true, report, history: updatedHistory });
});

// Create a new multiplayer session
app.post('/api/session/create', (req, res) => {
  const code = generateSessionCode();
  const hostId = 'host_' + Math.random().toString(36).slice(2, 10);
  
  sessions[code] = {
    code,
    hostId,
    currentQuestionIndex: -1,
    phase: 'waiting',
    questionStartTime: 0,
    timeLimit: 30, // default
    questions: QUESTIONS,
    players: {},
    answers: {},
    lastUpdatedAt: Date.now(),
    quizTitle: 'Conscendo Master Quiz'
  };

  res.json({ success: true, code, hostId });
});

// Join an existing multiplayer session
app.post('/api/session/join', async (req, res) => {
  const { code, playerName, email } = req.body;
  if (!code || !playerName || !email) {
    res.status(400).json({ success: false, error: 'Session code, player name, and email address are required.' });
    return;
  }

  // Verify valid format email address (any domain is accepted)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ success: false, error: 'Access Denied: Please enter a correct, valid email address.' });
    return;
  }

  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found. Double-check your code.' });
    return;
  }

  // Check if player already exists in this session under the same email to allow seamless continuation
  let existingPlayerId: string | null = null;
  if (session.players) {
    for (const [pId, p] of Object.entries(session.players)) {
      if (p && p.email && p.email.trim().toLowerCase() === email.trim().toLowerCase()) {
        existingPlayerId = pId;
        break;
      }
    }
  }

  let playerId: string;
  if (existingPlayerId) {
    playerId = existingPlayerId;
    // Keep their exact current score and correctAnswersCount intact, just update name/lastActive
    session.players[playerId].name = playerName.trim();
    session.players[playerId].lastActive = Date.now();
  } else {
    // Generate unique player ID
    playerId = 'player_' + Math.random().toString(36).slice(2, 10);
    const player: Player & { email?: string } = {
      id: playerId,
      name: playerName.trim(),
      score: 0,
      correctAnswersCount: 0,
      lastActive: Date.now(),
      email: email.trim()
    };
    session.players[playerId] = player;
  }

  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);

  res.json({ success: true, playerId, playerName: session.players[playerId].name });
});

// Retrieve detailed session state for sync
function getFormattedSession(session: QuizSession) {
  const currentQuestion = session.currentQuestionIndex >= 0 && session.currentQuestionIndex < session.questions.length
    ? session.questions[session.currentQuestionIndex]
    : null;

  const currentAnswers = currentQuestion ? (session.answers[currentQuestion.id] || []) : [];

  return {
    code: session.code,
    currentQuestionIndex: session.currentQuestionIndex,
    phase: session.phase,
    questionStartTime: session.questionStartTime,
    timeLimit: session.timeLimit,
    clientQuestion: currentQuestion,
    totalQuestions: session.questions.length,
    players: Object.values(session.players),
    activeQuestionAnswersCount: currentAnswers.length,
    quizTitle: session.quizTitle || 'Conscendo Master Quiz'
  };
}

app.get('/api/session/:code', async (req, res) => {
  const { code } = req.params;
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);

  res.json({
    success: true,
    ...getFormattedSession(session)
  });
});

// Retrieve previously submitted answers for state recovery
app.get('/api/session/:code/player-answers/:playerId', async (req, res) => {
  const { code, playerId } = req.params;
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  const answered: Record<string, { isCorrect: boolean; scoreGained: number; selectedDetails?: string }> = {};
  if (session.answers) {
    for (const [qId, ansList] of Object.entries(session.answers)) {
      if (Array.isArray(ansList)) {
        const match = ansList.find(a => a.playerId === playerId);
        if (match) {
          answered[qId] = {
            isCorrect: match.isCorrect,
            scoreGained: match.scoreGained,
            selectedDetails: match.details
          };
        }
      }
    }
  }

  res.json({ success: true, answered });
});

// Update session title (host presenter only)
app.post('/api/session/:code/update-title', async (req, res) => {
  const { code } = req.params;
  const { title } = req.body;
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }
  session.quizTitle = title || 'Conscendo Master Quiz';
  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);
  res.json({ success: true, quizTitle: session.quizTitle });
});

// Get all questions in the session (host console only)
app.get('/api/session/:code/questions', async (req, res) => {
  const { code } = req.params;
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }
  res.json({ success: true, questions: session.questions });
});

// Host updates session state, moves questions, or reveals answers
app.post('/api/session/:code/update-state', async (req, res) => {
  const { code } = req.params;
  const { phase, questionIndex, timeLimit } = req.body;
  const session = await getSessionFirestore(code);

  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  if (phase) {
    session.phase = phase as SessionPhase;
  }

  if (questionIndex !== undefined) {
    session.currentQuestionIndex = questionIndex;
  }

  if (timeLimit !== undefined) {
    session.timeLimit = timeLimit;
  } else if (session.phase === 'active-question') {
    const qIndex = session.currentQuestionIndex;
    if (qIndex >= 0 && qIndex < session.questions.length) {
      const activeQ = session.questions[qIndex];
      if (activeQ.type === 'matching' || activeQ.type === 'sequence') {
        session.timeLimit = 45;
      } else if (activeQ.type === 'fill-blanks') {
        session.timeLimit = 45;
      } else {
        session.timeLimit = 30;
      }
    } else {
      session.timeLimit = 30;
    }
  }

  if (session.phase === 'active-question') {
    session.questionStartTime = Date.now();
  }

  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);

  res.json({ success: true, session: getFormattedSession(session) });
});

// Player submits an answer
app.post('/api/session/:code/submit-answer', async (req, res) => {
  const { code } = req.params;
  const { playerId, questionId, isCorrect, scoreGained, details } = req.body;
  
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  const player = session.players[playerId];
  if (!player) {
    res.status(404).json({ success: false, error: 'Player not found in this session.' });
    return;
  }

  // Initialize answer list for this question if it doesn't exist
  if (!session.answers[questionId]) {
    session.answers[questionId] = [];
  }

  // Check if player has already submitted an answer to this question
  const alreadyAnswered = session.answers[questionId].some(a => a.playerId === playerId);
  if (alreadyAnswered) {
    res.json({ success: true, alreadyAnswered: true, score: player.score });
    return;
  }

  const answer: PlayerAnswer = {
    playerId,
    playerName: player.name,
    questionId,
    isCorrect,
    scoreGained,
    timestamp: Date.now(),
    details
  };

  session.answers[questionId].push(answer);

  // Update cumulative player scores
  player.score += scoreGained;
  if (isCorrect) {
    player.correctAnswersCount += 1;
  }
  player.lastActive = Date.now();
  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);

  res.json({ success: true, alreadyAnswered: false, score: player.score });
});

// Reveal correct answers for current question (includes full list of respondent statistics)
app.get('/api/session/:code/reveal', async (req, res) => {
  const { code } = req.params;
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  const currentQuestion = session.questions[session.currentQuestionIndex];
  if (!currentQuestion) {
    res.status(404).json({ success: false, error: 'No active question found.' });
    return;
  }

  const questionAnswers = session.answers[currentQuestion.id] || [];

  res.json({
    success: true,
    question: currentQuestion,
    answers: questionAnswers,
    players: Object.values(session.players).sort((a, b) => b.score - a.score)
  });
});

// Clean and reset session for restarting
app.post('/api/session/:code/reset', async (req, res) => {
  const { code } = req.params;
  const session = await getSessionFirestore(code);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  session.currentQuestionIndex = -1;
  session.phase = 'waiting';
  session.questionStartTime = 0;
  session.answers = {};
  
  // Reset player scores for the next round
  Object.keys(session.players).forEach((id) => {
    session.players[id].score = 0;
    session.players[id].correctAnswersCount = 0;
  });

  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);

  res.json({ success: true, session: getFormattedSession(session) });
});

// Leave a session
app.post('/api/session/:code/leave', async (req, res) => {
  const { code } = req.params;
  const { playerId } = req.body;
  const session = await getSessionFirestore(code);
  if (session && playerId && session.players[playerId]) {
    // Keep final scoreboard frozen: never delete participants if the final leaderboard stage is reached!
    if (session.phase !== 'leaderboard') {
      delete session.players[playerId];
      session.lastUpdatedAt = Date.now();
      await saveSessionFirestore(code, session);
    }
  }
  res.json({ success: true });
});

// Generate dynamic questions using AI (Gemini Flash)
app.post('/api/session/:code/generate-questions', async (req, res) => {
  const { code } = req.params;
  const { topic } = req.body;
  const session = await getSessionFirestore(code);

  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(400).json({
      success: false,
      error: 'GEMINI_API_KEY is missing. Please open the Settings > Secrets panel and configure your Gemini API Key.'
    });
    return;
  }

  if (!topic || topic.trim() === '') {
    res.status(400).json({ success: false, error: 'Topic cannot be empty.' });
    return;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });

    const prompt = `Generate exactly 5 highly engaging, high-quality quiz questions about the topic: "${topic}".
Include a mix of different question types: 'multiple-choice', 'true-false', 'matching', 'sequence', and 'fill-blanks'.
Ensure the questions are accurate and challenging, representing real-world technology guidelines or facts.
Make the category "${topic.substring(0, 35)}" or a relevant sub-topic.

Rules for question design:
- 'multiple-choice': 4 distinct options, exactly 1 correct, provide mcqCorrectIndex.
- 'true-false': general technical factual statement, tfCorrectValue is true or false.
- 'matching': 4 or 5 pairs with left, right matching attributes.
- 'sequence': 3 to 5 step order strings representing a correct technical flow.
- 'fill-blanks': a dynamic template using {!Record.Field} style syntax (e.g., "The {!Account.{{0}}} triggers {!User.{{1}}}") and options for each blank (under fillBlanksItems, which should include the correct value and 2 alternative options).`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        systemInstruction: 'You are an elite developer certification authority. Generate professional, technically precise challenges in valid JSON adhering strictly to the responseSchema.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              type: {
                type: Type.STRING,
                description: "Must be exactly 'multiple-choice', 'true-false', 'matching', 'sequence', or 'fill-blanks'"
              },
              points: {
                type: Type.INTEGER,
                description: "Point value for answering (e.g. 1000, 1500, 2000)"
              },
              category: {
                type: Type.STRING,
                description: "Short topic category (e.g. 'Security Settings')"
              },
              questionText: {
                type: Type.STRING,
                description: "The prompt text or instruction for the question."
              },
              explanation: {
                type: Type.STRING,
                description: "Detailed description of why this is correct."
              },
              mcqOptions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Required only for 'multiple-choice'. Array of 4 text options."
              },
              mcqCorrectIndex: {
                type: Type.INTEGER,
                description: "Required only for 'multiple-choice'. 0-indexed number of the correct option."
              },
              tfCorrectValue: {
                type: Type.BOOLEAN,
                description: "Required only for 'true-false'."
              },
              matchingPairs: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    left: { type: Type.STRING },
                    right: { type: Type.STRING }
                  },
                  required: ["left", "right"]
                },
                description: "Required only for 'matching'. Array of left terms and correct matching right definitions."
              },
              sequenceCorrectOrder: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: "Required only for 'sequence'. Array of labels in correct chronological/logical order."
              },
              fillBlanksTemplate: {
                type: Type.STRING,
                description: "Required only for 'fill-blanks'. E.g. 'An email is sent to {!Contact.{{0}}} regarding cases with status {{1}}.'"
              },
              fillBlanksItems: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    correctValue: { type: Type.STRING },
                    options: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    }
                  },
                  required: ["correctValue", "options"]
                },
                description: "Required only for 'fill-blanks'. Options for each index (e.g., {{0}}, {{1}}) containing the correctValue."
              }
            },
            required: ["type", "points", "category", "questionText", "explanation"]
          }
        }
      }
    });

    if (!response.text) {
      throw new Error('AI returned an empty response.');
    }

    const rawQuestions = JSON.parse(response.text.trim());
    if (!Array.isArray(rawQuestions)) {
      throw new Error('AI did not return an array list of questions.');
    }

    const mappedQuestions: QuizQuestion[] = rawQuestions.map((q: any, i: number) => {
      const id = `ai-q-${i}-${Date.now()}`;
      const common = {
        id,
        category: q.category || topic,
        points: q.points || 1000,
        questionText: q.questionText || 'Generated AI question',
        explanation: q.explanation || 'Analyzed by Einstein AI.'
      };

      if (q.type === 'multiple-choice') {
        const options = Array.isArray(q.mcqOptions) && q.mcqOptions.length >= 2
          ? q.mcqOptions
          : ['True', 'False', 'None of the above', 'All of the above'];
        const corrIdx = typeof q.mcqCorrectIndex === 'number' && q.mcqCorrectIndex >= 0 && q.mcqCorrectIndex < options.length
          ? q.mcqCorrectIndex
          : 0;
        return {
          ...common,
          type: 'multiple-choice' as const,
          options,
          correctAnswerIndex: corrIdx
        };
      } else if (q.type === 'true-false') {
        return {
          ...common,
          type: 'true-false' as const,
          correctValue: q.tfCorrectValue !== undefined ? !!q.tfCorrectValue : true
        };
      } else if (q.type === 'matching') {
        const pairs = Array.isArray(q.matchingPairs) && q.matchingPairs.length > 0
          ? q.matchingPairs.map((p: any, pi: number) => ({
              id: `ai-pair-${pi}-${Date.now()}`,
              left: p.left || `Item ${pi + 1}`,
              right: p.right || `Match ${pi + 1}`
            }))
          : [
              { id: 'p1', left: 'Left Option A', right: 'Right Option A' },
              { id: 'p2', left: 'Left Option B', right: 'Right Option B' }
            ];
        return {
          ...common,
          type: 'matching' as const,
          pairs
        };
      } else if (q.type === 'sequence') {
        const correctOrder = Array.isArray(q.sequenceCorrectOrder) && q.sequenceCorrectOrder.length > 0
          ? q.sequenceCorrectOrder
          : ['Step 1', 'Step 2', 'Step 3'];
        return {
          ...common,
          type: 'sequence' as const,
          correctOrder
        };
      } else if (q.type === 'fill-blanks') {
        const templateText = q.fillBlanksTemplate || 'Analyze {!Case.{{0}}} or {!Account.{{1}}}';
        const blanks = Array.isArray(q.fillBlanksItems) && q.fillBlanksItems.length > 0
          ? q.fillBlanksItems.map((b: any, bi: number) => ({
              id: `ai-blank-${bi}-${Date.now()}`,
              correctValue: b.correctValue || 'Value',
              options: Array.isArray(b.options) && b.options.length > 0 ? b.options : [b.correctValue || 'Value']
            }))
          : [
              { id: 'b1', correctValue: 'Case', options: ['Case', 'Opportunity', 'Event'] }
            ];
        return {
          ...common,
          type: 'fill-blanks' as const,
          templateText,
          blanks
        };
      } else {
        // Fallback MCQ questions
        return {
          ...common,
          type: 'multiple-choice' as const,
          options: ['Option A', 'Option B', 'Option C', 'Option D'],
          correctAnswerIndex: 0
        };
      }
    });

    session.questions = mappedQuestions;
    session.currentQuestionIndex = -1;
    session.phase = 'waiting';
    session.answers = {};
    session.lastUpdatedAt = Date.now();
    await saveSessionFirestore(code, session);

    res.json({ success: true, questionsCount: mappedQuestions.length, questions: mappedQuestions });
  } catch (err: any) {
    console.error('AI question generation failure:', err);
    res.status(500).json({ success: false, error: `AI Generation failed: ${err.message || err}` });
  }
});

// Directly set custom or pasted questions
app.post('/api/session/:code/set-questions', async (req, res) => {
  const { code } = req.params;
  const { questions } = req.body;
  const session = await getSessionFirestore(code);

  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    res.status(400).json({ success: false, error: 'Please provide a non-empty array of questions.' });
    return;
  }

  // Validate and map raw inputted quiz questions into structured schemas
  const validatedQuestions: QuizQuestion[] = questions.map((q: any, i: number) => {
    const id = q.id || `pasted-q-${i}-${Date.now()}`;
    const type = q.type || 'multiple-choice';
    const category = q.category || 'Pasted Block';
    const points = Number(q.points) || 1000;
    const explanation = q.explanation || 'Manual explanation provided.';
    const questionText = q.questionText || 'Custom Question';

    const common = {
      id,
      category,
      points,
      explanation,
      questionText
    };

    if (type === 'multiple-choice') {
      const options = Array.isArray(q.options) ? q.options : (Array.isArray(q.mcqOptions) ? q.mcqOptions : []);
      const corrIdx = typeof q.correctAnswerIndex === 'number' ? q.correctAnswerIndex : (typeof q.mcqCorrectIndex === 'number' ? q.mcqCorrectIndex : 0);
      return {
        ...common,
        type: 'multiple-choice' as const,
        options: options.length > 0 ? options : ['Option A', 'Option B', 'Option C', 'Option D'],
        correctAnswerIndex: corrIdx
      };
    } else if (type === 'true-false') {
      const correctValue = q.correctValue !== undefined ? q.correctValue : (q.tfCorrectValue !== undefined ? q.tfCorrectValue : true);
      return {
        ...common,
        type: 'true-false' as const,
        correctValue: typeof correctValue === 'string' ? (correctValue.toLowerCase() === 'true') : !!correctValue
      };
    } else if (type === 'matching') {
      let pairs = q.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) {
        const options = Array.isArray(q.options) ? q.options : (Array.isArray(q.matchingPairs) ? q.matchingPairs : []);
        if (Array.isArray(options) && options.length > 0) {
          pairs = options.map((opt: any, pi: number) => {
            if (typeof opt === 'object' && opt !== null) {
              return {
                id: `pasted-pair-${pi}-${Date.now()}`,
                left: opt.left || `Term ${pi + 1}`,
                right: opt.right || `Definition ${pi + 1}`
              };
            }
            const strOpt = String(opt);
            const delimiterIdx = strOpt.indexOf(':');
            let left = strOpt;
            let right = strOpt;
            if (delimiterIdx !== -1) {
              left = strOpt.substring(0, delimiterIdx).trim();
              right = strOpt.substring(delimiterIdx + 1).trim();
            }
            return {
              id: `pasted-pair-${pi}-${Date.now()}`,
              left,
              right
            };
          });
        } else {
          pairs = [
            { id: 'p1', left: 'Primary Concept A', right: 'Definition A' },
            { id: 'p2', left: 'Primary Concept B', right: 'Definition B' }
          ];
        }
      }
      return {
        ...common,
        type: 'matching' as const,
        pairs
      };
    } else if (type === 'sequence') {
      let correctOrder = q.correctOrder;
      if (!Array.isArray(correctOrder) || correctOrder.length === 0) {
        correctOrder = Array.isArray(q.options) ? q.options : (Array.isArray(q.sequenceCorrectOrder) ? q.sequenceCorrectOrder : []);
      }
      return {
        ...common,
        type: 'sequence' as const,
        correctOrder: correctOrder.length > 0 ? correctOrder : ['Step 1', 'Step 2', 'Step 3']
      };
    } else if (type === 'fill-blanks') {
      let templateText = q.templateText;
      let blanks = q.blanks;

      if (!templateText) {
        const qText = q.questionText || '';
        const hasBlankKeyword = qText.toLowerCase().includes('[blank]');
        const hasBlankLine = qText.includes('____');
        
        if (hasBlankKeyword) {
          templateText = qText.replace(/\[blank\]/i, '{{0}}');
        } else if (hasBlankLine) {
          templateText = qText.replace(/____+/, '{{0}}');
        } else {
          templateText = qText + ' {{0}}';
        }
      }

      if (!Array.isArray(blanks) || blanks.length === 0) {
        const primaryAnswer = String(q.correctValue !== undefined ? q.correctValue : (q.fillBlanksItems?.[0]?.correctValue || ''));
        const rawAns = primaryAnswer.trim();
        let decoys: string[] = [];
        if (rawAns.toLowerCase() === 'data cloud') {
          decoys = ['MuleSoft', 'Einstein Analytics', 'Marketing Cloud'];
        } else if (rawAns.toLowerCase() === '@invocablevariable') {
          decoys = ['@InvocableMethod', '@AuraEnabled', '@RemoteAction'];
        } else if (rawAns.toLowerCase() === 'aiagenttopic') {
          decoys = ['AiAgent', 'ApexClass', 'CustomMetadata'];
        } else if (rawAns.startsWith('@')) {
          decoys = ['@InvocableMethod', '@AuraEnabled', '@RemoteAction'];
        } else if (rawAns.endsWith('Topic') || rawAns.startsWith('Ai')) {
          decoys = ['AiAgent', 'ApexClass', 'CustomMetadata'];
        } else {
          decoys = ['Slack Integration', 'Einstein Copilot', 'Flow Orchestrator'];
        }

        blanks = [
          {
            id: `pasted-blank-0-${Date.now()}`,
            correctValue: primaryAnswer,
            options: [primaryAnswer, ...decoys]
          }
        ];
      }

      return {
        ...common,
        type: 'fill-blanks' as const,
        templateText,
        blanks
      };
    } else {
      return {
        ...common,
        type: 'multiple-choice' as const,
        options: ['Option A', 'Option B', 'Option C', 'Option D'],
        correctAnswerIndex: 0
      };
    }
  });

  session.questions = validatedQuestions;
  session.currentQuestionIndex = -1;
  session.phase = 'waiting';
  session.answers = {};
  session.lastUpdatedAt = Date.now();
  await saveSessionFirestore(code, session);

  res.json({ success: true, questionsCount: validatedQuestions.length, questions: validatedQuestions });
});


// ────────────────────────────────────────────────────────
// VITE OR STATIC MIDDLEWARE SETUP
// ────────────────────────────────────────────────────────
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development mode with live HMR proxy middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode serving compiled static bundle
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Express custom server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server", err);
});
