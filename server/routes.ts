import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from 'path';
import fs from "fs";
import { storage } from "./storage";
import { db } from "./db";
import { contacts } from "@shared/schema";
import { sql } from "drizzle-orm";
import { 
  insertContactSchema, 
  insertCampaignSchema,
  insertCallSchema,
  insertWhatsAppTemplateSchema, 
  insertBulkMessageJobSchema,
  campaigns
} from "@shared/schema";
import { MessagingService } from "./services/messagingService";
import { WhatsAppTemplateService } from "./services/whatsappTemplateService";
import { WhatsAppService } from "./services/whatsappService";
import { callManager } from "./services/callManager";
import { twilioService } from "./services/twilioService";
import express from "express";  
import multer from "multer";

// Configure multer for file uploads with larger limit for CSV files
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit for large CSV files
});

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Broadcast to all connected clients
  const broadcast = (data: any) => {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  };

  // Export broadcast function for use in other modules
  (global as any).broadcastToClients = broadcast;

  wss.on('connection', (ws) => {
    console.log('WebSocket client connected');

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
    });
  });

  // Dashboard API routes
  app.get('/api/dashboard/stats', async (req, res) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (error) {
      console.error('Error fetching dashboard stats:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard stats' });
    }
  });

  // Get ElevenLabs voices - ALL available voices including custom
  app.get('/api/elevenlabs/voices', async (req, res) => {
    try {
      const { ElevenLabsService } = await import('./services/elevenlabsService');
      const voices = await ElevenLabsService.getVoices();
      res.json(voices);
    } catch (error) {
      console.error('Error fetching ElevenLabs voices:', error);
      res.status(500).json({ error: 'Failed to fetch voices' });
    }
  });

  // Campaigns API routes
  app.get('/api/campaigns', async (req, res) => {
    try {
      const campaigns = await storage.getCampaigns();
      res.json(campaigns);
    } catch (error) {
      console.error('Error fetching campaigns:', error);
      res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
  });

  app.post('/api/campaigns', async (req, res) => {
    try {
      const campaignData = insertCampaignSchema.parse(req.body);
      const campaign = await storage.createCampaign(campaignData);

      broadcast({ type: 'campaign_created', campaign });

      res.status(201).json(campaign);
    } catch (error) {
      console.error('Error creating campaign:', error);
      res.status(500).json({ error: 'Failed to create campaign' });
    }
  });

  app.put('/api/campaigns/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const campaignData = req.body;

      const updatedCampaign = await storage.updateCampaign(id, campaignData);

      broadcast({ type: 'campaign_updated', campaign: updatedCampaign });

      res.json(updatedCampaign);
    } catch (error) {
      console.error('Error updating campaign:', error);
      res.status(500).json({ error: 'Failed to update campaign' });
    }
  });

  app.delete('/api/campaigns/:id', async (req, res) => {
    try {
      const { id } = req.params;

      await storage.deleteCampaign(id);

      broadcast({ type: 'campaign_deleted', campaignId: id });

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting campaign:', error);
      res.status(500).json({ error: 'Failed to delete campaign' });
    }
  });

  // Contacts API routes
  app.get('/api/contacts', async (req, res) => {
    try {
      const contacts = await storage.getContacts();
      res.json(contacts);
    } catch (error) {
      console.error('Error fetching contacts:', error);
      res.status(500).json({ error: 'Failed to fetch contacts' });
    }
  });

  app.post('/api/contacts', async (req, res) => {
    try {
      const contactData = insertContactSchema.parse(req.body);
      const contact = await storage.createContact(contactData);
      res.status(201).json(contact);
    } catch (error) {
      console.error('Error creating contact:', error);
      res.status(500).json({ error: 'Failed to create contact' });
    }
  });

  app.put('/api/contacts/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const contactData = req.body;

      const updatedContact = await storage.updateContact(id, contactData);
      res.json(updatedContact);
    } catch (error) {
      console.error('Error updating contact:', error);
      res.status(500).json({ error: 'Failed to update contact' });
    }
  });

  app.delete('/api/contacts/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteContact(id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting contact:', error);
      res.status(500).json({ error: 'Failed to delete contact' });
    }
  });

  // ===========================
  // AUDIO SERVING ENDPOINT
  // ===========================

  // Serve audio files for Twilio to play
  app.get('/audio/:filename', (req, res) => {
    try {
      const filename = req.params.filename;
      let audioFilePath;

      // Check both temp/ and temp/static-audio/ directories
      if (filename === 'typing-sound.mp3') {
        audioFilePath = path.join(process.cwd(), 'temp', 'static-audio', filename);
      } else {
        audioFilePath = path.join(process.cwd(), 'temp', filename);
      }

      if (!fs.existsSync(audioFilePath)) {
        // Try alternate location
        const alternatePath = filename === 'typing-sound.mp3' 
          ? path.join(process.cwd(), 'temp', filename)
          : path.join(process.cwd(), 'temp', 'static-audio', filename);

        if (fs.existsSync(alternatePath)) {
          audioFilePath = alternatePath;
        } else {
          console.log('Audio file not found in either location:', audioFilePath, 'or', alternatePath);
          return res.status(404).send('Audio file not found');
        }
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const audioStream = fs.createReadStream(audioFilePath);
      audioStream.pipe(res);

      // Clean up file after 5 minutes
      setTimeout(() => {
        if (fs.existsSync(audioFilePath)) {
          fs.unlinkSync(audioFilePath);
          console.log(`🗑️ Cleaned up audio file: ${filename}`);
        }
      }, 5 * 60 * 1000);

    } catch (error) {
      console.error('Error serving audio file:', error);
      res.status(500).send('Error serving audio file');
    }
  });

  // Contact import/export
  app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Import contacts from CSV
      const { ExcelService } = await import('./services/excelService');
      const excelService = new ExcelService();
      const result = await excelService.importContactsFromCsv(req.file.buffer);

      res.json(result);
    } catch (error) {
      console.error('Error importing contacts:', error);
      res.status(500).json({ error: 'Failed to import contacts' });
    }
  });

  app.get('/api/contacts/export', async (req, res) => {
    try {
      const { ExcelService } = await import('./services/excelService');
      const excelService = new ExcelService();
      const buffer = await excelService.exportContactsToCsv();

      res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
      res.setHeader('Content-Type', 'text/csv');
      res.send(buffer);
    } catch (error) {
      console.error('Error exporting contacts:', error);
      res.status(500).json({ error: 'Failed to export contacts' });
    }
  });

  // WhatsApp messaging routes
  app.get('/api/whatsapp/templates', async (req, res) => {
    try {
      const templates = await storage.getWhatsAppTemplates();
      res.json(templates);
    } catch (error) {
      console.error('Error fetching WhatsApp templates:', error);
      res.status(500).json({ error: 'Failed to fetch templates' });
    }
  });

  app.post('/api/whatsapp/templates', async (req, res) => {
    try {
      const templateData = insertWhatsAppTemplateSchema.parse(req.body);
      const template = await storage.createWhatsAppTemplate(templateData);
      res.status(201).json(template);
    } catch (error) {
      console.error('Error creating WhatsApp template:', error);
      res.status(500).json({ error: 'Failed to create template' });
    }
  });

  app.get('/api/whatsapp/bulk-jobs', async (req, res) => {
    try {
      const jobs = await storage.getBulkMessageJobs();
      res.json(jobs);
    } catch (error) {
      console.error('Error fetching bulk message jobs:', error);
      res.status(500).json({ error: 'Failed to fetch jobs' });
    }
  });

  app.post('/api/whatsapp/bulk-send', async (req, res) => {
    try {
      const jobData = insertBulkMessageJobSchema.parse(req.body);
      const job = await storage.createBulkMessageJob(jobData);

      // Start the messaging process
      const messagingService = new MessagingService();
      messagingService.processBulkJob(job.id);

      res.status(201).json(job);
    } catch (error) {
      console.error('Error creating bulk message job:', error);
      res.status(500).json({ error: 'Failed to create bulk message job' });
    }
  });

  // ===================
  // CAMPAIGN MANAGEMENT ROUTES
  // ===================

  // Get all campaigns
  app.get("/api/campaigns", async (req, res) => {
    try {
      const allCampaigns = await storage.getCampaigns();
      res.json(allCampaigns);
    } catch (error) {
      console.error('Error fetching campaigns:', error);
      res.status(500).json({ error: "Failed to fetch campaigns" });
    }
  });

  // Create new campaign
  app.post("/api/campaigns", async (req, res) => {
    try {
      const campaignData = {
        ...req.body,
        script: req.body.introLine, // Use introLine as script for compatibility
      };

      const campaign = await storage.createCampaign(campaignData);
      res.status(201).json(campaign);
    } catch (error) {
      console.error('Error creating campaign:', error);
      res.status(500).json({ error: "Failed to create campaign" });
    }
  });

  // Update campaign
  app.put("/api/campaigns/:id", async (req, res) => {
    try {
      const campaignData = {
        ...req.body,
        script: req.body.introLine, // Use introLine as script for compatibility
      };

      const campaign = await storage.updateCampaign(req.params.id, campaignData);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json(campaign);
    } catch (error) {
      console.error('Error updating campaign:', error);
      res.status(500).json({ error: "Failed to update campaign" });
    }
  });

  // Delete campaign
  app.delete("/api/campaigns/:id", async (req, res) => {
    try {
      const success = await storage.deleteCampaign(req.params.id);
      if (!success) {
        return res.status(404).json({ error: "Campaign not found" });
      }
      res.json({ message: "Campaign deleted successfully" });
    } catch (error) {
      console.error('Error deleting campaign:', error);
      res.status(500).json({ error: "Failed to delete campaign" });
    }
  });

  // ===================
  // AI CALLING ROUTES
  // ===================

  // Start a new call
  app.post("/api/calls", async (req, res) => {
    try {
      const { contactId, campaignId, phoneNumber } = req.body;

      if (!contactId || !campaignId || !phoneNumber) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const result = await callManager.startCall(contactId, campaignId, phoneNumber);

      if (result.success) {
        broadcast({
          type: 'call_started',
          callId: result.callId,
          phoneNumber
        });

        res.json({ success: true, callId: result.callId });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (error) {
      console.error('Error starting call:', error);
      res.status(500).json({ error: "Failed to start call" });
    }
  });

  // Initiate call from campaign manager 
  app.post('/api/calls/initiate', async (req, res) => {
    try {
      const { phoneNumber, campaignId } = req.body;

      if (!phoneNumber || !campaignId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Phone number and campaign ID are required' 
        });
      }

      // Create a temporary contact for this call
      const tempContact = await storage.createContact({
        name: `Direct Call ${phoneNumber}`,
        phone: phoneNumber,
        phoneNumber: phoneNumber
      });

      const result = await callManager.startCall(tempContact.id, campaignId, phoneNumber);

      if (result.success) {
        console.log(`🎹 AI call initiated with background typing sounds to ${phoneNumber}`);
        res.json({ 
          success: true, 
          callId: result.callId,
          message: 'Call initiated with natural conversation flow including background typing sounds'
        });
      } else {
        res.status(500).json({ 
          success: false, 
          error: result.error 
        });
      }
    } catch (error) {
      console.error('Error initiating call:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to initiate call' 
      });
    }
  });

  // Get all calls
  app.get("/api/calls", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const calls = await storage.getCalls(limit);
      res.json(calls);
    } catch (error) {
      console.error('Error fetching calls:', error);
      res.status(500).json({ error: "Failed to fetch calls" });
    }
  });

  // Get active calls
  app.get("/api/calls/active", async (req, res) => {
    try {
      const activeCalls = callManager.getActiveCalls();
      res.json(activeCalls);
    } catch (error) {
      console.error('Error fetching active calls:', error);
      res.status(500).json({ error: "Failed to fetch active calls" });
    }
  });

  // Get call by ID
  app.get("/api/calls/:id", async (req, res) => {
    try {
      const call = await storage.getCall(req.params.id);
      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }
      res.json(call);
    } catch (error) {
      console.error('Error fetching call:', error);
      res.status(500).json({ error: "Failed to fetch call" });
    }
  });

  // Get call messages
  app.get("/api/calls/:id/messages", async (req, res) => {
    try {
      const messages = await storage.getCallMessages(req.params.id);
      res.json(messages);
    } catch (error) {
      console.error('Error fetching call messages:', error);
      res.status(500).json({ error: "Failed to fetch call messages" });
    }
  });

  // ===========================
  // TWILIO WEBHOOK ROUTES
  // ===========================

  // Answer webhook - when Twilio call is answered (returns TwiML with intro)  
  // This route MUST return TwiML XML for Twilio to work properly
  app.post("/api/calls/webhook/answer", async (req, res) => {
    console.log('🔔 ANSWER WEBHOOK CALLED - Generating intro with ElevenLabs');
    console.log('📞 Query params:', req.query);
    console.log('📞 Request body:', req.body);

    try {
      const { callId, campaignId } = req.query;

      if (!callId || !campaignId) {
        console.log('❌ Missing callId or campaignId in answer webhook');
        return res.status(400).send('Missing callId or campaignId');
      }

      // Get campaign for intro generation
      const campaign = await storage.getCampaign(campaignId as string);
      if (!campaign) {
        console.log('❌ Campaign not found for answer webhook');
        return res.status(404).send('Campaign not found');
      }

      // Ensure call is tracked
      console.log(`🔗 Answer webhook for call ${callId}, ensuring it's tracked as active`);
      const dbCall = await storage.getCall(callId as string);
      if (dbCall && dbCall.status === 'active') {
        callManager.ensureCallIsTracked(callId as string, dbCall);
      }

      // Generate intro with ElevenLabs
      const introText = campaign.introLine || "Hello, this is an AI calling agent from LabsCheck.";
      let twiml;

      try {
        console.log(`🎤 Generating ElevenLabs intro with campaign voice: ${campaign.voiceId}`);
        console.log(`📋 Campaign details - Model: ${campaign.elevenlabsModel}, Language: ${campaign.language}`);
        console.log(`📝 Intro text: "${introText}"`);

        const { ElevenLabsService } = await import('./services/elevenlabsService');
        const fs = await import('fs');
        const path = await import('path');

        const voiceConfig = campaign.voiceConfig as any;
        const audioBuffer = await ElevenLabsService.textToSpeech(
          introText,
          campaign.voiceId,
          {
            stability: voiceConfig?.stability || 0.5,
            similarityBoost: voiceConfig?.similarityBoost || 0.75,
            style: voiceConfig?.style || 0.0,
            speakerBoost: voiceConfig?.useSpeakerBoost || true,
            model: campaign.elevenlabsModel || 'eleven_turbo_v2',
            language: campaign.language || 'en'
          }
        );

        // Save audio file
        const audioFileName = `intro_${callId}.mp3`;
        const audioFilePath = path.default.join(process.cwd(), 'temp', audioFileName);
        const tempDir = path.default.join(process.cwd(), 'temp');
        if (!fs.default.existsSync(tempDir)) {
          fs.default.mkdirSync(tempDir, { recursive: true });
        }
        fs.default.writeFileSync(audioFilePath, audioBuffer);

        // Create accessible URL
        const baseUrl = process.env.REPLIT_DEV_DOMAIN ? 
          `https://${process.env.REPLIT_DEV_DOMAIN}` : 
          `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
        const audioUrl = `${baseUrl}/audio/${audioFileName}`;

        console.log(`✅ ElevenLabs intro generated successfully: ${audioUrl}`);

        // Generate TwiML with ElevenLabs audio and background typing sounds
        twiml = await twilioService.generateTwiML('gather', {
          audioUrl: audioUrl,
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign.language || 'en',
          addTypingSound: true, // Customer will hear typing sounds
          addThinkingPause: true
        });

      } catch (elevenlabsError) {
        console.error('❌ ElevenLabs intro failed, using fallback:', elevenlabsError);

        // Quick fallback with Twilio TTS to prevent application error
        twiml = await twilioService.generateTwiML('gather', {
          text: introText,
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign.language || 'en',
          voice: 'alice',
          addTypingSound: false // Skip typing sound for fallback
        });
        console.log('✅ Using Twilio TTS fallback to prevent application error');
      }

      console.log(`🎙️ Returning TwiML for intro: "${introText}"`);
      console.log('🎹 Background typing sounds enabled with Twilio direct speech processing');

      // CRITICAL: Return TwiML XML, not HTML
      res.type('text/xml').send(twiml);

    } catch (error) {
      console.error('🚨 ANSWER WEBHOOK ERROR:', error instanceof Error ? error.message : String(error));
      console.error('🚨 Stack trace:', error instanceof Error ? error.stack : 'No stack');

      // Provide a more robust fallback TwiML
      const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en">Hello, this is an AI assistant from LabsCheck. How can I help you today?</Say>
  <Gather input="speech" language="en-US" speechTimeout="5" action="/api/calls/${callId || 'unknown'}/process-speech" method="POST">
    <Say voice="alice">Please speak after the tone.</Say>
  </Gather>
</Response>`;
      res.type('text/xml').send(fallbackTwiml);
    }
  });

  // Main webhook for call handling
  app.post("/api/calls/webhook", async (req, res) => {
    try {
      console.log('🔥 Webhook starting with query params:', req.query);
      const { callId, campaignId } = req.query;

      if (!callId || !campaignId) {
        return res.status(400).send('Missing callId or campaignId');
      }

      // Ensure call is tracked in active calls
      console.log(`🔗 Webhook triggered for call ${callId}, ensuring it's tracked as active`);
      const dbCall = await storage.getCall(callId as string);
      if (dbCall && dbCall.status === 'active') {
        // Make sure call manager is tracking this call
        callManager.ensureCallIsTracked(callId as string, dbCall);
      }

      // Get campaign for initial script
      const campaign = await storage.getCampaign(campaignId as string);
      if (!campaign) {
        return res.status(404).send('Campaign not found');
      }

      // Try ElevenLabs first, fallback to Twilio if fails
      const introText = campaign.introLine || "Hello, this is an AI calling agent from LabsCheck.";
      let twiml;

      try {
        console.log(`🎤 Generating ElevenLabs intro with campaign voice: ${campaign.voiceId}`);
        console.log(`📋 Campaign details - Model: ${campaign.elevenlabsModel}, Language: ${campaign.language}`);
        console.log(`📝 Intro text: "${introText}"`);

        const { ElevenLabsService } = await import('./services/elevenlabsService');
        const fs = await import('fs');
        const path = await import('path');

        const voiceConfig = campaign.voiceConfig as any;
        const audioBuffer = await ElevenLabsService.textToSpeech(
          introText,
          campaign.voiceId,
          {
            stability: voiceConfig?.stability || 0.5,
            similarityBoost: voiceConfig?.similarityBoost || 0.75,
            style: voiceConfig?.style || 0.0,
            speakerBoost: voiceConfig?.useSpeakerBoost || true,
            model: campaign.elevenlabsModel || 'eleven_turbo_v2',
            language: campaign.language || 'en'
          }
        );

        // Save audio file
        const audioFileName = `intro_${callId}.mp3`;
        const audioFilePath = path.join(process.cwd(), 'temp', audioFileName);
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        fs.writeFileSync(audioFilePath, audioBuffer);

        // Use same URL construction pattern as conversation responses for consistency
        const baseUrl = process.env.REPLIT_DEV_DOMAIN ? 
          `https://${process.env.REPLIT_DEV_DOMAIN}` : 
          `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
        const audioUrl = `${baseUrl}/audio/${audioFileName}`;

        console.log(`🔗 Created ElevenLabs intro audio URL: ${audioUrl}`);

        console.log(`✅ Using ElevenLabs voice: ${campaign.voiceId}, audio URL: ${audioUrl}`);

        // Use ElevenLabs audio in TwiML
        twiml = await twilioService.generateTwiML('gather', {
          audioUrl: audioUrl,
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign.language || 'en'
        });

      } catch (elevenlabsError) {
        console.error('❌ ElevenLabs intro failed, using Twilio TTS fallback:', elevenlabsError);
        console.error('❌ ElevenLabs error details:', elevenlabsError instanceof Error ? elevenlabsError.message : String(elevenlabsError));

        // Fallback to fast Twilio TTS
        twiml = await twilioService.generateTwiML('gather', {
          text: introText,
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign.language || 'en',
          voice: 'alice'
        });
      }


      console.log(`🎙️ Starting call with intro: "${campaign.introLine}"`);
      console.log('🎹 Background typing sounds enabled with Twilio direct speech processing');

      res.type('text/xml').send(twiml);
    } catch (error) {
      console.error('🚨 WEBHOOK ERROR - Full details:', error instanceof Error ? error.message : String(error));
      console.error('🚨 WEBHOOK ERROR - Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
      console.error('🚨 WEBHOOK ERROR - Query params:', req.query);
      res.status(500).send('Internal server error');
    }
  });

  // Enhanced speech processing to use OpenAI Whisper for transcription
  app.post("/api/calls/recording-complete", async (req, res) => {
    try {
      const { callId } = req.query;
      const recordingUrl = req.body.RecordingUrl;

      if (!callId || !recordingUrl) {
        console.log('❌ Missing callId or recording URL in recording-complete');
        return res.status(400).json({ error: 'Missing callId or recording URL' });
      }

      console.log(`🎙️ Processing recording for enhanced OpenAI Whisper: ${recordingUrl}`);

      // Download and transcribe audio using OpenAI Whisper directly
      const audioResponse = await fetch(recordingUrl);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      // Import OpenAI service for enhanced transcription
      const { OpenAIService } = await import('./services/openaiService');
      const speechText = await OpenAIService.transcribeAudio(audioBuffer);

      console.log(`🎤 Enhanced OpenAI Whisper transcription: "${speechText}"`);

      // Process the transcribed speech
      const result = await callManager.processSpeechInput(callId as string, speechText);
      res.type('text/xml').send(result.twiml);

    } catch (error) {
      console.error('❌ Enhanced recording processing error:', error);
      const twiml = await twilioService.generateTwiML('hangup', {
        text: 'Thank you for your time. Goodbye.'
      });
      res.type('text/xml').send(twiml);
    }
  });

  // Enhanced speech processing with OpenAI Whisper fallback
  app.post("/api/calls/:callId/process-speech", async (req, res) => {
    try {
      const { callId } = req.params;

      // First try to get speech result from Twilio's direct speech recognition
      let speechText = "";
      if (req.body.SpeechResult) {
        const { directSpeechService } = await import('./services/directSpeechService');
        const rawSpeechText = directSpeechService.processTwilioSpeechInput(
          req.body.SpeechResult,
          req.body.UnstableSpeechResult, 
          req.body.Digits
        );
        speechText = directSpeechService.validateSpeechInput(rawSpeechText);
        console.log(`🎤 Twilio speech recognition result: "${speechText}"`);
      }

      // If no speech from Twilio, check if there's a recording URL for OpenAI Whisper processing
      if ((!speechText || speechText.trim() === "") && req.body.RecordingUrl) {
        console.log(`🎧 No Twilio speech result, using OpenAI Whisper for: ${req.body.RecordingUrl}`);

        try {
          const audioResponse = await fetch(req.body.RecordingUrl);
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

          const { OpenAIService } = await import('./services/openaiService');
          speechText = await OpenAIService.transcribeAudio(audioBuffer);
          console.log(`🎤 OpenAI Whisper backup transcription: "${speechText}"`);
        } catch (whisperError) {
          console.error('❌ OpenAI Whisper fallback failed:', whisperError);
        }
      }

      console.log(`🎤 Final processed speech for call ${callId}: "${speechText}"`);

      if (!speechText || speechText.trim() === "") {
        // Continue listening with better prompt
        console.log('🔄 No speech detected, continuing to listen...');
        const dbCall = await storage.getCall(callId);
        const campaign = dbCall?.campaignId ? await storage.getCampaign(dbCall.campaignId) : null;

        const twiml = await twilioService.generateTwiML('gather', {
          text: 'I\'m here. Please speak when you\'re ready.',
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign?.language || 'en',
          addTypingSound: true, // Customer will hear typing sounds
          addThinkingPause: true
        });
        res.type('text/xml').send(twiml);
        return;
      }

      // Import direct speech service for validation
      const { directSpeechService } = await import('./services/directSpeechService');

      // Check if call should end based on speech content
      if (directSpeechService.shouldEndCall(speechText)) {
        console.log('🔚 User indicated call should end');
        const dbCall = await storage.getCall(callId);
        const campaign = dbCall?.campaignId ? await storage.getCampaign(dbCall.campaignId) : null;

        const twiml = await twilioService.generateTwiML('hangup', {
          text: 'I understand. Thank you for your time. Have a great day!',
          language: campaign?.language || 'en',
          addTypingSound: true // Customer will hear typing sounds
        });
        res.type('text/xml').send(twiml);
        return;
      }

      // Process with AI using campaign settings
      const result = await callManager.processSpeechInput(callId, speechText);

      console.log(`🤖 AI response generated successfully with OpenAI integration`);

      res.type('text/xml').send(result.twiml);
    } catch (error) {
      console.error('Enhanced speech processing error:', error);
      const twiml = await twilioService.generateTwiML('hangup', {
        text: 'Thank you for your time. Goodbye.'
      });
      res.type('text/xml').send(twiml);
    }
  });

  // Call status webhook
  app.post("/api/calls/webhook/status", async (req, res) => {
    try {
      const { callId } = req.query;
      const { CallStatus, CallDuration, CallSid, From, To } = req.body;

      console.log(`📞 Call Status Update - CallID: ${callId}, Status: ${CallStatus}, Duration: ${CallDuration}, SID: ${CallSid}, From: ${From}, To: ${To}`);
      console.log(`📋 Full webhook body:`, req.body);

      if (callId && (CallStatus === 'completed' || CallStatus === 'failed')) {
        console.log(`🔚 Call ${callId} ending with status: ${CallStatus}, duration: ${CallDuration}`);
        await callManager.completeCall(
          callId as string, 
          CallDuration ? parseInt(CallDuration) : undefined
        );

        broadcast({
          type: 'call_ended',
          callId,
          status: CallStatus
        });
      }

      res.status(200).send('OK');
    } catch (error) {
      console.error('Status webhook error:', error);
      res.status(500).send('Error');
    }
  });

  // Removed recording webhook - not needed for direct speech processing

  // Global reference for broadcasting
  (global as any).broadcastToClients = broadcast;



  return httpServer;
}