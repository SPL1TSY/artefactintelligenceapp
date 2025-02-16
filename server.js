import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import mongoose from "mongoose"
import favicon from "serve-favicon";
import path from "path";
import { fileURLToPath } from "url"; // Needed for ES Modules
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
    origin: "https://artefactintelligenceapp.up.railway.app",  // 🔄 Replace with your frontend URL
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

const OPENAI_HEADERS = {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2"  // ✅ Required for Assistants API v2
};

// Connect to MongoDB
mongoose.set("strictQuery", true);
mongoose.set("bufferCommands", false); // Prevents buffering if disconnected

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 30000, // ⏳ Increase timeout to 30 seconds
    socketTimeoutMS: 45000, // Increase query timeout
})
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err);
        process.exit(1); // 🚨 Exit if database is unavailable
    });

// Debugging: Listen for connection events
mongoose.connection.on("connecting", () => console.log("⏳ Connecting to MongoDB..."));
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected successfully!"));
mongoose.connection.on("error", err => console.error("❌ MongoDB Error:", err));
mongoose.connection.on("disconnected", () => console.error("⚠️ MongoDB Disconnected!"));

const threadSchema = new mongoose.Schema({
    threadId: String,
    participantId: String,
    createdAt: { type: Date, default: Date.now },
    messages: [{ role: String, content: String, timestamp: Date }]
});

const Thread = mongoose.model("Thread", threadSchema);

// Get correct directory paths for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the frontend files
app.use(express.static(path.join(__dirname, "public")));  // Serves static files from "public" folder

app.use(favicon(path.join(__dirname, "public", "favicon.ico")));

// Route to serve the main HTML file
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "Index.html"));
});

// API route for fetching adapted descriptions with failure detection
app.post("/fetch-description", async (req, res) => {
    console.log("🛠️ Received fetch-description request:", req.body); // ✅ Debugging log

    const { artefact, originalDescription, profile, participantId } = req.body;

    if (!artefact || !originalDescription || !profile || !participantId) {
        console.error("❌ Missing required fields: artefact, description, profile, or participantId");
        return res.status(400).json({ error: "Missing artefact, description, profile, or participantId" });
    }

    let prompt = `Adapt the following description of the artefact "${artefact}" to align with the interests, expectations, storytelling and engagement styles of a visitor with the "${profile}" profile. Description: ${originalDescription}.`;

    try {
        console.log("🟢 Creating a new thread...");

        const threadResponse = await fetch("https://api.openai.com/v1/threads", {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ metadata: { participantId } }),  // ✅ Store Participant ID in OpenAI thread metadata
            timeout: 60000,
        });

        const threadData = await threadResponse.json();
        if (!threadData.id) throw new Error("Failed to create thread");

        const threadId = threadData.id;
        console.log(`✅ Created Thread ID: ${threadId} (Participant: ${participantId})`);

        // 🛑 Ensure MongoDB is connected before saving the thread
        if (mongoose.connection.readyState !== 1) {
            console.error("❌ MongoDB is not connected. Skipping thread save.");
            return res.status(500).json({ error: "Database connection lost. Please try again later." });
        }

        const newThread = new Thread({
            threadId,
            participantId,
            createdAt: new Date(),
            messages: []
        });

        try {
            await newThread.save();
            console.log(`✅ Thread saved in MongoDB (ID: ${threadId})`);
        } catch (error) {
            console.error("❌ Error saving thread to MongoDB:", error);
            return res.status(500).json({ error: "Failed to save thread in database." });
        }

        console.log(`📝 Sending prompt to Assistant:\n${prompt}`);
        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });

        const messageData = await messageResponse.json();
        if (!messageData.id) throw new Error("Failed to add message");

        console.log("▶️ Running Assistant...");
        const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });

        const runData = await runResponse.json();
        if (!runData.id) throw new Error("Failed to run assistant");

        const runId = runData.id;
        console.log(`✅ Assistant Run ID: ${runId}, Participant ID: ${participantId})`);

        let status = "in_progress";
        let responseContent = "";

        while (status === "in_progress" || status === "queued") {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
                headers: OPENAI_HEADERS,
            });

            const checkRunData = await checkRunResponse.json();
            status = checkRunData.status;
            console.log("⏳ Adaptation Status:", status);

            if (status === "failed") {
                console.error("❌ Assistant Run Failed:", checkRunData);
                break;
            }

            if (status === "completed") {
                console.log("📩 Fetching Assistant's Response...");
                const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
                    headers: OPENAI_HEADERS,
                });

                const messagesData = await messagesResponse.json();
                const assistantMessage = messagesData.data.find(msg => msg.role === "assistant");

                if (assistantMessage && assistantMessage.content && assistantMessage.content[0].text) {
                    responseContent = assistantMessage.content[0].text.value;
                    console.log(`🟢 Assistant response received for Participant ${participantId}:`, responseContent);

                    // ✅ Store AI response in MongoDB
                    await Thread.findOneAndUpdate(
                        { threadId },
                        { $push: { messages: { role: "assistant", content: responseContent, timestamp: new Date() } } }
                    );
                }
                break;
            }
        }

        if (!responseContent) {
            responseContent = `The adaptation failed. However, here's the original artefact description:\n\n${originalDescription}`;
        }

        // ✅ Store user prompt in MongoDB
        await Thread.findOneAndUpdate(
            { threadId },
            { $push: { messages: { role: "user", content: prompt, timestamp: new Date() } } }
        );

        res.json({ response: responseContent });

    } catch (error) {
        console.error("❌ Error fetching from Assistant:", error);
        res.status(500).json({ response: `The adaptation failed. However, here's the original artefact description:\n\n${originalDescription}` });
    }
});

// API route for fetching additional artefact details (for "Tell Me More" button)
app.post("/fetch-more-info", async (req, res) => {
    console.log("🛠️ Received fetch-more-info request:", req.body); // ✅ Debugging log

    const { artefact, profile, participantId } = req.body;

    if (!artefact || !profile || !participantId) {
        console.error("❌ Missing required fields: artefact, profile, or participantId");
        return res.status(400).json({ error: "Missing artefact, profile, or participantId" });
    }

    try {
        console.log(`🔍 Searching for existing thread for Participant ID: ${participantId}...`);
        let thread = await Thread.findOne({ participantId });

        if (!thread) {
            console.error("❌ No existing thread found for this participant.");
            return res.status(400).json({ error: "No existing thread found. Please start again." });
        }

        let threadId = thread.threadId;
        console.log(`✅ Found existing thread: ${threadId}`);

        let prompt = `The visitor wants to learn more about the artefact "${artefact}" for a "${profile}" visitor. Provide additional historical or cultural insights.`;

        console.log(`📝 Sending additional prompt to Assistant:\n${prompt}`);
        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ role: "user", content: prompt }),
            timeout: 60000,
        });

        const messageData = await messageResponse.json();
        if (!messageData.id) throw new Error("Failed to add message");

        console.log("▶️ Running Assistant for additional info...");
        const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: "POST",
            headers: OPENAI_HEADERS,
            body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID }),
            timeout: 60000,
        });

        const runData = await runResponse.json();
        if (!runData.id) throw new Error("Failed to run assistant");

        const runId = runData.id;
        console.log(`✅ Additional Info Run ID: ${runId}, Participant ID: ${participantId}`);

        let status = "in_progress";
        let responseContent = "";

        while (status === "in_progress" || status === "queued") {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const checkRunResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
                headers: OPENAI_HEADERS,
            });

            const checkRunData = await checkRunResponse.json();
            status = checkRunData.status;
            console.log("⏳ Additional Info Status:", status);

            if (status === "failed") {
                console.error("❌ Assistant Run Failed:", checkRunData);
                break;
            }

            if (status === "completed") {
                console.log("📩 Fetching Assistant's Additional Info Response...");
                const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
                    headers: OPENAI_HEADERS,
                });

                const messagesData = await messagesResponse.json();
                const assistantMessage = messagesData.data.find(msg => msg.role === "assistant");

                if (assistantMessage && assistantMessage.content && assistantMessage.content[0].text) {
                    responseContent = assistantMessage.content[0].text.value;
                    console.log(`🟢 Assistant additional info received for Participant ${participantId}:`, responseContent);

                    // ✅ Store AI response in MongoDB
                    await Thread.findOneAndUpdate(
                        { threadId },
                        { $push: { messages: { role: "assistant", content: responseContent, timestamp: new Date() } } }
                    );
                }
                break;
            }
        }

        if (!responseContent) {
            responseContent = `No additional information is available for this artefact at this time.`;
        }

        res.json({ response: responseContent });

    } catch (error) {
        console.error("❌ Error fetching additional info:", error);
        res.status(500).json({ response: "Failed to fetch additional information." });
    }
});

// API route for fetching TTS audio
app.post("/fetch-tts", async (req, res) => {
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ error: "Missing text input for TTS" });
    }

    try {
        const audioBuffer = await fetchTTSWithRetry(text);

        res.set({
            "Content-Type": "audio/mpeg",
            "Content-Length": audioBuffer.length,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        });

        res.send(audioBuffer);
    } catch (error) {
        console.error("❌ Error fetching TTS:", error);
        res.status(500).json({ error: "Failed to generate TTS audio" });
    }
});


// ✅ Function to fetch TTS with automatic retries
async function fetchTTSWithRetry(text, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Sending Text-to-Speech Request (Attempt ${i + 1})...`);

            const response = await fetch("https://api.openai.com/v1/audio/speech", {
                method: "POST",
                headers: OPENAI_HEADERS,
                body: JSON.stringify({
                    model: "tts-1",
                    input: text,
                    voice: "nova",
                }),
                timeout: 60000,  // ✅ Increase timeout to 60s
            });

            if (!response.ok) throw new Error(`Failed to generate audio: ${response.statusText}`);

            const audioBuffer = await response.arrayBuffer();
            console.log("🔊 TTS Audio successfully generated!");
            return Buffer.from(audioBuffer);
        } catch (error) {
            console.error(`❌ TTS attempt ${i + 1} failed:`, error);
            if (i === retries - 1) {
                console.error("🚨 TTS service unavailable after multiple retries.");
                throw error;
            }
            await new Promise(res => setTimeout(res, 2000)); // ⏳ Wait before retrying
        }
    }
}

app.get("/fetch-stored-threads", async (req, res) => {
    try {
        const threads = await Thread.find({}); // Fetch all stored threads from MongoDB
        res.json({ threads });
    } catch (error) {
        console.error("❌ Error fetching stored threads:", error);
        res.status(500).json({ error: "Failed to fetch stored threads" });
    }
});

app.get("/export-threads", async (req, res) => {
    try {
        const threads = await Thread.find({});
        const jsonData = JSON.stringify(threads, null, 2);

        fs.writeFileSync("threads.json", jsonData);
        console.log("✅ Threads exported to threads.json");

        res.download("threads.json"); // Sends file as download
    } catch (error) {
        console.error("❌ Error exporting threads:", error);
        res.status(500).json({ error: "Failed to export threads" });
    }
});


console.log("🔑 OpenAI API Key:", process.env.OPENAI_API_KEY ? "Loaded" : "MISSING");
console.log("🤖 Assistant ID:", process.env.ASSISTANT_ID ? "Loaded" : "MISSING");


// ✅ Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

