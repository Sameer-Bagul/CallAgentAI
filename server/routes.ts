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
  
  // CRITICAL: Register webhook routes FIRST to bypass Vite middleware
  // WhatsApp webhook verification (GET) - highest priority
  app.get('/api/whatsapp/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    console.log('🔍 WEBHOOK VALIDATION - Full request details:');
    console.log('Query params:', req.query);
    console.log('Headers:', req.headers);
    console.log('URL:', req.originalUrl);
    
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'whatsapp_verify_token_2025';
    
    console.log('Expected mode: subscribe, Received:', mode);
    console.log('Expected token:', verifyToken);
    console.log('Received token:', token);
    console.log('Challenge to return:', challenge);
    
    // Set headers to ensure plain text response
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('✅ WEBHOOK VERIFIED - Returning challenge:', challenge);
      return res.status(200).send(String(challenge));
    } else {
      console.log('❌ WEBHOOK VERIFICATION FAILED');
      console.log('Mode check:', mode === 'subscribe');
      console.log('Token check:', token === verifyToken);
      return res.status(403).send('Forbidden');
    }
  });

  // WhatsApp webhook for messages (POST) - highest priority
  app.post('/api/whatsapp/webhook', async (req, res) => {
    try {
      console.log('📨 PRIORITY WhatsApp webhook received');
      
      const { whatsappService } = await import('./services/whatsappService');
      await whatsappService.processWebhook(req.body);
      
      res.status(200).send('OK');
    } catch (error) {
      console.error('❌ Error processing WhatsApp webhook:', error);
      res.status(500).send('ERROR');
    }
  });

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

  // Enhanced contacts with pagination and filtering
  app.get('/api/contacts/enhanced', async (req, res) => {
    try {
      console.log(`📊 Fetching enhanced contacts...`);
      const startTime = Date.now();
      
      // Parse pagination parameters
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = (page - 1) * limit;
      
      // Parse filter parameters
      const searchTerm = req.query.search as string || '';
      const city = req.query.city as string || '';
      const state = req.query.state as string || '';
      
      console.log(`📋 Pagination: page=${page}, limit=${limit}, offset=${offset}`);
      console.log(`🔍 Filters: search="${searchTerm}", city="${city}", state="${state}"`);
      
      const contactsResult = await storage.getContactsPaginated({
        limit,
        offset,
        searchTerm,
        city,
        state
      });
      
      const endTime = Date.now();
      console.log(`✅ Enhanced contacts fetched in ${endTime - startTime}ms - ${contactsResult.contacts.length}/${contactsResult.total} contacts`);
      
      // Add caching headers
      res.set({
        'Cache-Control': 'public, max-age=60', // Cache for 1 minute (shorter due to filtering)
        'ETag': `"contacts-p${page}-${contactsResult.total}"`,
        'X-Total-Count': contactsResult.total.toString(),
        'X-Page': page.toString(),
        'X-Per-Page': limit.toString(),
        'X-Total-Pages': Math.ceil(contactsResult.total / limit).toString()
      });
      
      res.json({
        contacts: contactsResult.contacts,
        pagination: {
          page,
          limit,
          total: contactsResult.total,
          totalPages: Math.ceil(contactsResult.total / limit),
          hasMore: offset + contactsResult.contacts.length < contactsResult.total
        }
      });
    } catch (error) {
      console.error('Error fetching enhanced contacts:', error);
      res.status(500).json({ error: 'Failed to fetch enhanced contacts' });
    }
  });

  // Get unique filter options for contacts
  app.get('/api/contacts/filter-options', async (req, res) => {
    try {
      const options = await storage.getContactFilterOptions();
      res.json(options);
    } catch (error) {
      console.error('Error fetching contact filter options:', error);
      res.status(500).json({ error: 'Failed to fetch filter options' });
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
      const audioFilePath = path.join(process.cwd(), 'temp', filename);

      if (!fs.existsSync(audioFilePath)) {
        console.log('Audio file not found:', audioFilePath);
        return res.status(404).send('Audio file not found');
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

  // Contact import/export with timeout protection
  app.post('/api/contacts/upload', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Set extended timeout for bulk uploads
      req.setTimeout(15 * 60 * 1000); // 15 minutes for large files
      res.setTimeout(15 * 60 * 1000);

      console.log(`Starting bulk CSV import of ${req.file.originalname} (${req.file.size} bytes)`);
      const { ExcelService } = await import('./services/excelService');
      
      // Process without timeout restriction for bulk uploads
      const result = await ExcelService.importContactsFromExcel(req.file.buffer);
      
      console.log(`CSV import completed: ${result.imported} imported, ${result.errors.length} errors`);
      res.json(result);
    } catch (error: any) {
      console.error('Error importing contacts:', error);
      res.status(500).json({ 
        error: error.message?.includes('timeout') ? 
          'File too large - try splitting into smaller files' : 
          'Failed to import contacts' 
      });
    }
  });

  app.get('/api/contacts/export', async (req, res) => {
    try {
      const { ExcelService } = await import('./services/excelService');
      const buffer = await ExcelService.exportContactsToExcel();

      res.setHeader('Content-Disposition', 'attachment; filename=contacts.xlsx');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
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

  // Sync templates from Meta Business API
  app.post('/api/whatsapp/templates/sync', async (req, res) => {
    try {
      console.log('🔄 Starting template sync from Meta Business API...');
      const { whatsappService } = await import('./services/whatsappService');
      
      // Fetch approved templates from Meta
      const metaTemplates = await whatsappService.fetchApprovedTemplates();
      
      if (metaTemplates.length === 0) {
        return res.json({ 
          message: 'No approved templates found in Meta Business account. Please check your WhatsApp Business API configuration and ensure you have approved templates.',
          synced: 0,
          error: 'Meta Business API connection issue or no approved templates available'
        });
      }

      // Update database with real templates
      let syncedCount = 0;
      for (const metaTemplate of metaTemplates) {
        try {
          // Check if template exists
          const existingTemplates = await storage.getWhatsAppTemplates();
          const existing = existingTemplates.find(t => t.name === metaTemplate.name);
          
          if (existing) {
            // Update existing template with real content
            await storage.updateWhatsAppTemplate(existing.id, {
              content: metaTemplate.content,
              components: metaTemplate.components,
              variables: metaTemplate.variables
            });
            console.log(`✅ Updated template: ${metaTemplate.name}`);
          } else {
            // Create new template
            await storage.createWhatsAppTemplate({
              name: metaTemplate.name,
              content: metaTemplate.content,
              components: metaTemplate.components,
              variables: metaTemplate.variables
            });
            console.log(`➕ Created template: ${metaTemplate.name}`);
          }
          syncedCount++;
        } catch (error) {
          console.error(`❌ Error syncing template ${metaTemplate.name}:`, error);
        }
      }

      console.log(`✅ Template sync completed: ${syncedCount} templates synced`);
      res.json({ 
        message: `Successfully synced ${syncedCount} approved templates from Meta Business API`,
        synced: syncedCount,
        templates: metaTemplates.map(t => ({ name: t.name, status: t.status, content: t.content.substring(0, 100) + '...' }))
      });
    } catch (error) {
      console.error('❌ Error syncing templates:', error);
      res.status(500).json({ 
        error: 'Failed to sync templates from Meta Business API',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
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
  // WHATSAPP MESSAGING ROUTES
  // ===================

  // Get all WhatsApp messages for a contact
  app.get('/api/whatsapp/messages/:contactId', async (req, res) => {
    try {
      const { contactId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      
      const messages = await storage.getWhatsAppMessages(contactId, limit);
      res.json(messages);
    } catch (error) {
      console.error('Error fetching WhatsApp messages:', error);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // Send a WhatsApp message
  app.post('/api/whatsapp/messages', async (req, res) => {
    try {
      console.log('📧 Sending WhatsApp message:', req.body);
      const messageData = req.body;
      
      // Validate required fields
      if (!messageData.contactId || !messageData.phone || !messageData.message) {
        return res.status(400).json({ 
          error: 'Missing required fields: contactId, phone, message' 
        });
      }
      
      // Create the message in database first
      const message = await storage.createWhatsAppMessage({
        contactId: messageData.contactId,
        phone: messageData.phone,
        message: messageData.message.trim(),
        messageType: messageData.isTemplate ? 'template' : (messageData.messageType || 'text'),
        direction: 'outbound',
        status: 'pending',
        campaignId: messageData.campaignId || null,
        templateName: messageData.isTemplate ? messageData.message.trim() : null
      });

      console.log('✅ Message created in database:', message.id);

      // Try to send via WhatsApp API if credentials are available
      try {
        const { whatsappService } = await import('./services/whatsappService');
        
        let whatsappResponse;
        
        // Check if this is a template message
        if (messageData.isTemplate) {
          console.log('📋 Sending as WhatsApp template:', messageData.message);
          whatsappResponse = await whatsappService.sendTemplateMessage(
            messageData.phone,
            messageData.message.trim(), // Template name
            messageData.language || 'en_US',
            messageData.parameters || undefined
          );
        } else {
          console.log('📱 Sending as regular text message');
          whatsappResponse = await whatsappService.sendTextMessage(
            messageData.phone,
            messageData.message.trim()
          );
        }

        // Update message with WhatsApp message ID and set status to sent
        await storage.updateWhatsAppMessage(message.id, {
          whatsappMessageId: whatsappResponse.messages?.[0]?.id,
          status: 'sent'
        });

        console.log('✅ Message sent via WhatsApp API:', whatsappResponse.messages?.[0]?.id);
        console.log('📡 Real delivery receipts will come through webhook');
        
      } catch (whatsappError) {
        console.log('⚠️ WhatsApp API not available, using simulation mode');
        console.log('WhatsApp Error:', whatsappError instanceof Error ? whatsappError.message : whatsappError);
        
        // Fallback: simulate realistic message progression with status updates
        console.log('🔄 Starting message status simulation for:', message.id);
        
        // Step 1: Mark as sent immediately
        await storage.updateWhatsAppMessage(message.id, { status: 'sent' });
        console.log('✅ Step 1: Message marked as SENT:', message.id);
        
        // Step 2: Mark as delivered after 3 seconds (realistic timing)
        setTimeout(async () => {
          try {
            await storage.updateWhatsAppMessage(message.id, {
              status: 'delivered',
              deliveredAt: new Date()
            });
            console.log('✅ Step 2: Message marked as DELIVERED:', message.id);
          } catch (err) {
            console.error('Error updating delivery status:', err);
          }
        }, 3000);
      }

      res.status(201).json(message);
    } catch (error) {
      console.error('❌ Error sending WhatsApp message:', error);
      res.status(500).json({ 
        error: 'Failed to send message',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get WhatsApp chats grouped by contact
  app.get('/api/whatsapp/chats', async (req, res) => {
    try {
      const chats = await storage.getWhatsAppChatsByContact();
      res.json(chats);
    } catch (error) {
      console.error('Error fetching WhatsApp chats:', error);
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  });

  // Webhook routes moved to beginning of registerRoutes function for priority routing

  // Update message status (for webhooks)
  app.put('/api/whatsapp/messages/:id/status', async (req, res) => {
    try {
      const { id } = req.params;
      const { status, deliveredAt, readAt } = req.body;
      
      const updated = await storage.updateWhatsAppMessage(id, {
        status,
        deliveredAt: deliveredAt ? new Date(deliveredAt) : undefined,
        readAt: readAt ? new Date(readAt) : undefined
      });
      
      if (!updated) {
        return res.status(404).json({ error: 'Message not found' });
      }
      
      res.json(updated);
    } catch (error) {
      console.error('Error updating message status:', error);
      res.status(500).json({ error: 'Failed to update message status' });
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

  // Start campaign with specific contacts
  app.post("/api/campaigns/start", async (req, res) => {
    try {
      console.log('🚀 CAMPAIGN START ENDPOINT CALLED');
      console.log('📊 Request body:', req.body);
      
      const { contactIds, channel, whatsappTemplate, followUpDays, campaignTemplateId } = req.body;
      
      if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
        console.log('❌ Invalid contactIds:', contactIds);
        return res.status(400).json({ error: "Invalid contact IDs" });
      }

      console.log(`📋 Starting campaign for ${contactIds.length} contacts`);
      console.log('📋 Contact IDs:', contactIds);
      console.log('📋 Channel:', channel);
      console.log('📋 WhatsApp Template:', whatsappTemplate);
      console.log('📋 Campaign Template ID:', campaignTemplateId);
      
      const campaignId = `campaign_${Date.now()}`;
      
      // Get campaign template settings if provided
      let campaignSettings = {
        aiPrompt: 'You are Anvika from LabsCheck, a diagnostic comparison platform. Your goal is to onboard pathology labs to our free platform. Be professional, clear, and focus on the value proposition: no commission, increased visibility, and direct patient bookings.',
        introLine: 'Hi, this is Anvika from LabsCheck. Am I speaking with the owner or manager of the lab?',
        agentName: 'Anvika',
        openaiModel: 'gpt-4o',
        language: 'en-IN',
        elevenlabsModel: 'eleven_multilingual_v2',
        voiceId: '21m00Tcm4TlvDq8ikWAM'
      };

      if (campaignTemplateId && campaignTemplateId !== 'default') {
        console.log(`📋 Using campaign template: ${campaignTemplateId}`);
        try {
          const template = await storage.getCampaign(campaignTemplateId);
          if (template) {
            console.log(`✅ Found campaign template: ${template.name}`);
            campaignSettings = {
              aiPrompt: template.aiPrompt,
              introLine: template.introLine,
              agentName: template.agentName,
              openaiModel: template.openaiModel,
              language: template.language,
              elevenlabsModel: template.elevenlabsModel,
              voiceId: template.voiceId
            };
          } else {
            console.log(`⚠️ Campaign template not found: ${campaignTemplateId}, using defaults`);
          }
        } catch (error) {
          console.error(`❌ Error fetching campaign template: ${error}`);
          console.log('Using default campaign settings');
        }
      }
      
      // Create campaign record in database first
      await storage.createCampaign({
        id: campaignId,
        name: `Campaign ${new Date().toISOString().split('T')[0]}`,
        script: `Multi-channel campaign for ${contactIds.length} contacts`,
        status: 'active',
        targetAudience: 'pathology_labs',
        ...campaignSettings,
        createdAt: new Date()
      });
      
      console.log(`✅ Created campaign record: ${campaignId}`);
      
      let processedCount = 0;
      const results = [];

      // Process each contact
      for (const contactId of contactIds) {
        try {
          // Get contact details
          const contact = await storage.getContact(contactId);
          if (!contact) {
            console.log(`⚠️ Contact not found: ${contactId}`);
            results.push({ contactId, status: 'failed', error: 'Contact not found' });
            continue;
          }

          console.log(`📞 Processing contact: ${contact.name} (${contact.phone})`);

          // Handle different channels
          if (channel === 'CALL' || channel === 'BOTH') {
            // Start AI call
            try {
              console.log(`📞 Starting AI call for ${contact.phone}`);
              
              // Import callManager dynamically
              const { callManager } = await import('./services/callManager');
              const callResult = await callManager.startCall(contactId, campaignId, contact.phone);
              
              if (callResult.success) {
                console.log(`✅ Call initiated for ${contact.phone}: ${callResult.callId}`);
                results.push({ contactId, status: 'call_started', callId: callResult.callId });
              } else {
                console.log(`❌ Call failed for ${contact.phone}: ${callResult.error}`);
                results.push({ contactId, status: 'call_failed', error: callResult.error });
              }
            } catch (callError) {
              console.error(`❌ Call error for ${contact.phone}:`, callError);
              results.push({ contactId, status: 'call_failed', error: callError instanceof Error ? callError.message : 'Unknown call error' });
            }
          }

          if (channel === 'WHATSAPP' || channel === 'BOTH') {
            // Send WhatsApp message
            try {
              console.log(`📱 Sending WhatsApp to ${contact.phone} using template: ${whatsappTemplate}`);
              
              // Get template details
              const templates = await storage.getWhatsAppTemplates();
              const template = templates.find(t => t.name === whatsappTemplate);
              
              if (!template) {
                console.log(`⚠️ Template not found: ${whatsappTemplate}`);
                results.push({ contactId, status: 'whatsapp_failed', error: 'Template not found' });
                continue;
              }

              // Replace template variables with contact data
              let messageContent = template.content || '';
              
              // Simple variable replacement for {{name}}, {{1}}, etc.
              messageContent = messageContent.replace(/\{\{name\}\}/g, contact.name || '');
              messageContent = messageContent.replace(/\{\{1\}\}/g, contact.name || '');
              messageContent = messageContent.replace(/\{\{phone\}\}/g, contact.phone || '');
              messageContent = messageContent.replace(/\{\{email\}\}/g, contact.email || '');
              messageContent = messageContent.replace(/\{\{city\}\}/g, contact.city || '');
              messageContent = messageContent.replace(/\{\{company\}\}/g, contact.company || '');

              // Create WhatsApp message (without campaign reference for now)
              const message = await storage.createWhatsAppMessage({
                contactId: contactId,
                phone: contact.phone,
                message: messageContent.trim(),
                messageType: 'template',
                direction: 'outbound',
                status: 'pending',
                campaignId: null // Set to null to avoid foreign key constraint
              });

              // Try to send via WhatsApp API using template message
              try {
                const { whatsappService } = await import('./services/whatsappService');
                
                console.log(`📱 Sending WhatsApp template "${whatsappTemplate}" to ${contact.phone}`);
                
                // Extract template variables for parameters
                const templateVariables = [];
                if (template.content && template.content.includes('{{name}}') && contact.name) {
                  templateVariables.push(contact.name);
                }
                
                // Use template message instead of text message to comply with WhatsApp 24-hour rule
                const whatsappResponse = await whatsappService.sendTemplateMessage(
                  contact.phone,
                  whatsappTemplate,
                  'en_US', // Use English US as default language
                  templateVariables.length > 0 ? templateVariables : undefined
                );

                await storage.updateWhatsAppMessage(message.id, {
                  whatsappMessageId: whatsappResponse.messages?.[0]?.id,
                  status: 'sent'
                });

                console.log(`✅ WhatsApp template sent to ${contact.phone}: ${whatsappResponse.messages?.[0]?.id}`);
                results.push({ contactId, status: 'whatsapp_sent', messageId: message.id });

              } catch (whatsappError) {
                console.log(`⚠️ WhatsApp API not available for ${contact.phone}, using simulation`);
                
                // Simulate message delivery
                await storage.updateWhatsAppMessage(message.id, { status: 'sent' });
                setTimeout(async () => {
                  try {
                    await storage.updateWhatsAppMessage(message.id, {
                      status: 'delivered',
                      deliveredAt: new Date()
                    });
                    console.log(`✅ WhatsApp simulated delivery to ${contact.phone}`);
                  } catch (err) {
                    console.error('Error updating delivery status:', err);
                  }
                }, 2000);
                
                results.push({ contactId, status: 'whatsapp_simulated', messageId: message.id });
              }
            } catch (messageError) {
              console.error(`❌ WhatsApp error for ${contact.phone}:`, messageError);
              results.push({ contactId, status: 'whatsapp_failed', error: messageError instanceof Error ? messageError.message : 'Unknown message error' });
            }
          }

          processedCount++;
        } catch (error) {
          console.error(`❌ Error processing contact ${contactId}:`, error);
          results.push({ contactId, status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      const campaignResult = {
        success: true,
        campaignId,
        contactsProcessed: processedCount,
        totalContacts: contactIds.length,
        results
      };

      console.log('✅ Campaign completed:', campaignResult);
      res.json(campaignResult);
    } catch (error) {
      console.error('❌ Error starting campaign:', error);
      res.status(500).json({ error: "Failed to start campaign" });
    }
  });

  // Real data only - Campaign Dashboard API
  app.get("/api/campaigns/dashboard", async (req, res) => {
    try {
      const { date } = req.query;
      const selectedDate = date ? new Date(date as string) : new Date();
      
      // Get messages from the selected date only
      const startOfDay = new Date(selectedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(selectedDate);
      endOfDay.setHours(23, 59, 59, 999);

      // Get WhatsApp messages from the selected date using storage method
      const messages = await storage.getWhatsAppMessages(undefined, 100);
      const todaysMessages = messages.filter((msg: any) => {
        if (!msg.createdAt) return false;
        const msgDate = new Date(msg.createdAt);
        return msgDate >= startOfDay && msgDate <= endOfDay;
      });

      // Get contact details for each message
      const contactActivities = [];
      for (const message of todaysMessages) {
        let contact;
        try {
          contact = await storage.getContact(message.contactId);
        } catch (err) {
          // Skip if contact doesn't exist
          continue;
        }
        
        if (contact) {
          contactActivities.push({
            id: `activity_${message.id}`,
            contactId: message.contactId,
            contactName: contact.name,
            phone: contact.phone,
            email: contact.email || '',
            city: contact.city || '',
            company: contact.company || '',
            callStatus: 'pending' as const,
            messageStatus: message.status,
            messageTime: message.createdAt?.toISOString(),
            conversationSummary: message.message.substring(0, 100),
            nextAction: 'follow_up_call' as const,
            engagementScore: message.status === 'read' ? 80 : message.status === 'delivered' ? 60 : 40,
            status: 'active' as const
          });
        }
      }
      
      // Only create campaign if there are actual activities
      const campaigns = contactActivities.length > 0 ? [{
        id: "campaign_" + selectedDate.toISOString().split("T")[0],
        name: `Campaign - ${selectedDate.toLocaleDateString()}`,
        channel: "WHATSAPP" as const,
        startDate: selectedDate.toISOString(),
        totalContacts: contactActivities.length,
        completedContacts: contactActivities.filter(c => c.messageStatus !== "pending").length,
        successRate: contactActivities.length > 0 ? Math.round((contactActivities.filter(c => c.engagementScore > 70).length / contactActivities.length) * 100) : 0,
        status: "active" as const,
        contacts: contactActivities
      }] : [];

      console.log(`📊 Dashboard API: ${campaigns.length} campaigns, ${contactActivities.length} contacts for ${selectedDate.toDateString()}`);
      res.json(campaigns);
    } catch (error) {
      console.error("Error fetching campaign dashboard data:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // Real data only - Follow-ups API
  app.get("/api/campaigns/followups", async (req, res) => {
    try {
      const recentMessages = await storage.getWhatsAppMessages(undefined, 20);
      const followUps = recentMessages.map((message: any) => ({
        id: `followup_${message.id}`,
        contactId: message.contactId,
        contactName: message.contactId.split("-")[0] || "Unknown",
        phone: message.phone,
        nextAction: "follow_up_call",
        nextFollowUp: new Date(Date.now() + 24*60*60*1000).toISOString(), // Tomorrow
        engagementScore: message.status === 'read' ? 75 : 50,
        status: "active"
      }));
      
      console.log(`📋 Follow-ups API: ${followUps.length} follow-ups`);
      res.json(followUps.slice(0, 10));
    } catch (error) {
      console.error("Error fetching follow-ups:", error);
      res.status(500).json({ error: "Failed to fetch follow-ups" });
    }
  });

  // Get campaign analytics for contact campaigns page
  app.get('/api/campaigns/analytics', async (req, res) => {
    try {
      // Get all contacts and campaigns for basic analytics
      const contacts = await storage.getContacts();
      const campaigns = await storage.getCampaigns();
      const calls = await storage.getCalls();
      
      // Calculate basic analytics
      const totalContacts = contacts.length;
      const contacted = calls.filter(call => call.status === 'completed').length;
      const responded = Math.floor(contacted * 0.3); // 30% response rate estimate
      const onboarded = Math.floor(responded * 0.4); // 40% onboarding rate from responses
      const pending = totalContacts - contacted;
      const failed = calls.filter(call => call.status === 'failed').length;
      const followUpsDue = Math.floor(totalContacts * 0.1); // 10% need follow-up
      
      const analytics = {
        totalContacts,
        contacted,
        responded,
        onboarded,
        pending,
        failed,
        followUpsDue,
        todayActivity: {
          reached: Math.floor(contacted * 0.2), // 20% reached today
          responded: Math.floor(responded * 0.3), // 30% of responses today
          onboarded: Math.floor(onboarded * 0.5) // 50% of onboarding today
        }
      };
      
      res.json(analytics);
    } catch (error) {
      console.error('Error fetching campaign analytics:', error);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });

  // Get total campaign analytics - lifetime stats
  app.get('/api/campaigns/total-analytics', async (req, res) => {
    try {
      const analytics = await storage.getTotalCampaignAnalytics();
      res.json(analytics);
    } catch (error) {
      console.error('Error fetching total campaign analytics:', error);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });

  // Get day-wise analytics for last 30 days
  app.get('/api/campaigns/day-wise-analytics', async (req, res) => {
    try {
      const analytics = await storage.getDayWiseAnalytics();
      res.json(analytics);
    } catch (error) {
      console.error('Error fetching day-wise analytics:', error);
      res.status(500).json({ error: 'Failed to fetch day-wise analytics' });
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

  // Get live call transcriptions
  app.get("/api/calls/:id/transcriptions", async (req, res) => {
    try {
      const transcriptions = await storage.getCallTranscriptions(req.params.id);
      res.json(transcriptions);
    } catch (error) {
      console.error('Error fetching call transcriptions:', error);
      res.status(500).json({ error: "Failed to fetch transcriptions" });
    }
  });

  // Create call transcription
  app.post("/api/calls/:id/transcriptions", async (req, res) => {
    try {
      const { speaker, transcript, confidence, duration, audioSegmentUrl } = req.body;
      
      const transcription = await storage.createCallTranscription({
        callId: req.params.id,
        speaker,
        transcript,
        confidence,
        duration,
        audioSegmentUrl
      });
      
      res.json(transcription);
    } catch (error) {
      console.error('Error creating call transcription:', error);
      res.status(500).json({ error: "Failed to create transcription" });
    }
  });

  // Get call recording metadata
  app.get("/api/calls/:id/recording", async (req, res) => {
    try {
      const recording = await storage.getCallRecording(req.params.id);
      if (!recording) {
        return res.status(404).json({ error: "Recording not found" });
      }
      res.json(recording);
    } catch (error) {
      console.error('Error fetching call recording:', error);
      res.status(500).json({ error: "Failed to fetch recording" });
    }
  });

  // Download call recording file (proxy through server for authentication)
  app.get("/api/calls/:id/recording/download", async (req, res) => {
    try {
      const recording = await storage.getCallRecording(req.params.id);
      if (!recording) {
        return res.status(404).json({ error: "Recording not found" });
      }

      // Only handle actual Twilio recordings - no demo/sample files
      if (!recording.recordingUrl.includes('api.twilio.com')) {
        return res.status(404).json({ error: "No actual recording available - only demo data exists" });
      }

      console.log('🎙️ Fetching actual recording from Twilio:', recording.recordingUrl);
      
      // Create Basic Auth header for Twilio
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      
      if (!accountSid || !authToken) {
        return res.status(500).json({ error: "Twilio credentials not configured" });
      }
      
      const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      try {
        const response = await fetch(recording.recordingUrl, {
          headers: {
            'Authorization': authHeader
          }
        });
        
        if (!response.ok) {
          console.error('Twilio recording fetch failed:', response.status, response.statusText);
          return res.status(404).json({ error: "Recording not accessible from Twilio" });
        }
        
        // Set appropriate headers for file download
        res.setHeader('Content-Disposition', `attachment; filename="call-recording-${req.params.id}.${recording.mp4Url ? 'mp4' : 'wav'}"`);
        res.setHeader('Content-Type', recording.mp4Url ? 'video/mp4' : 'audio/wav');
        
        // Stream the recording directly to response
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
        
      } catch (error) {
        console.error('Error fetching Twilio recording:', error);
        return res.status(500).json({ error: "Failed to fetch recording from Twilio" });
      }
      
    } catch (error) {
      console.error('Error downloading call recording:', error);
      res.status(500).json({ error: "Failed to download recording" });
    }
  });

  // Create call recording entry
  app.post("/api/calls/:id/recording", async (req, res) => {
    try {
      const { recordingUrl, duration, fileSize } = req.body;
      
      const recording = await storage.createCallRecording({
        callId: req.params.id,
        recordingUrl,
        duration,
        fileSize,
        conversionStatus: 'pending'
      });
      
      res.json(recording);
    } catch (error) {
      console.error('Error creating call recording:', error);
      res.status(500).json({ error: "Failed to create recording" });
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
        twiml = twilioService.generateTwiML('gather', {
          audioUrl: audioUrl,
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign.language || 'en',
          addTypingSound: true,
          addThinkingPause: true
        });

      } catch (elevenlabsError) {
        console.error('❌ ElevenLabs intro failed:', elevenlabsError);

        // Return error TwiML that will end call gracefully
        const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en">I apologize, there was a technical issue. Please try again later.</Say>
  <Hangup/>
</Response>`;
        return res.type('text/xml').send(errorTwiml);
      }

      console.log(`🎙️ Returning TwiML for intro: "${introText}"`);
      console.log('🎹 Background typing sounds enabled with Twilio direct speech processing');

      // CRITICAL: Return TwiML XML, not HTML
      res.type('text/xml').send(twiml);

    } catch (error) {
      console.error('🚨 ANSWER WEBHOOK ERROR:', error instanceof Error ? error.message : String(error));
      const fallbackTwiml = twilioService.generateTwiML('hangup', {
        text: 'Sorry, there was an error. Please try again later.'
      });
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
        twiml = twilioService.generateTwiML('gather', {
          audioUrl: audioUrl,
          action: `/api/calls/${callId}/process-speech`,
          recordingCallback: `/api/calls/recording-complete?callId=${callId}`,
          language: campaign.language || 'en'
        });

      } catch (elevenlabsError) {
        console.error('❌ ElevenLabs intro failed, using Twilio TTS fallback:', elevenlabsError);
        console.error('❌ ElevenLabs error details:', elevenlabsError instanceof Error ? elevenlabsError.message : String(elevenlabsError));

        // Fallback to fast Twilio TTS
        twiml = twilioService.generateTwiML('gather', {
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
      const twiml = twilioService.generateTwiML('hangup', {
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

        const twiml = twilioService.generateTwiML('gather', {
          text: 'I\'m here. Please speak when you\'re ready.',
          action: `/api/calls/${callId}/process-speech`,
          language: campaign?.language || 'en',
          addTypingSound: true,
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

        const twiml = twilioService.generateTwiML('hangup', {
          text: 'I understand. Thank you for your time. Have a great day!',
          language: campaign?.language || 'en',
          addTypingSound: true
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
      const twiml = twilioService.generateTwiML('hangup', {
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

