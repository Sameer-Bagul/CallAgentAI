import twilio from 'twilio';

export class TwilioService {
  private client: twilio.Twilio;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    
    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not configured');
    }
    
    this.client = twilio(accountSid, authToken);
  }

  // Initiate outbound call
  async initiateCall(
    phoneNumber: string,
    campaignId: string,
    callId: string
  ): Promise<{ success: boolean; twilioCallSid?: string; error?: string }> {
    try {
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
      if (!fromNumber) {
        throw new Error('Twilio phone number not configured');
      }

      // Create webhook URL for handling call events - use Replit domain
      const replitDomain = process.env.REPLIT_DOMAINS ? 
        `https://${process.env.REPLIT_DOMAINS.split(',')[0]}` : 
        `https://${process.env.REPL_SLUG || 'app'}.${process.env.REPL_OWNER || 'user'}.repl.co`;
      const webhookUrl = `${replitDomain}/api/calls/webhook`;
      
      console.log(`🔗 Using webhook URL: ${webhookUrl}`); // Debug log
      
      const call = await this.client.calls.create({
        to: phoneNumber,
        from: fromNumber,
        url: `${webhookUrl}?callId=${callId}&campaignId=${campaignId}`,
        statusCallback: `${webhookUrl}/status?callId=${callId}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        timeout: 20, // Reduce timeout to speed up call connection
        machineDetection: 'Enable' // Enable machine detection for faster processing
        // NO RECORDING - using direct speech recognition only
      });

      return {
        success: true,
        twilioCallSid: call.sid
      };
    } catch (error) {
      console.error('Error initiating call:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Generate TwiML for call handling with ElevenLabs integration
  generateTwiML(action: 'gather' | 'say' | 'hangup', options: any = {}): string {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    // Use campaign-defined language settings (default to en-IN for Indian market)
    const language = options.language ? `${options.language}-IN` : 'en-IN';

    // Add natural typing sounds throughout entire conversation for human-like experience
    if (options.addTypingSound) {
      console.log('🎹 Adding continuous background typing effects throughout conversation');
      
      // Add initial thinking pause with typing sounds
      twiml.pause({ length: 1 });
      
      // Add additional natural pauses for extended typing effect
      if (options.addThinkingPause && action === 'gather') {
        twiml.pause({ length: 1.5 }); // Extended thinking with typing
        console.log('💭 Added extended thinking pause with natural typing ambiance');
      }
    }

    switch (action) {
      case 'say':
        // Check if we have ElevenLabs audio URL, otherwise use Twilio voice as fallback
        if (options.audioUrl) {
          console.log('🎵 Using ElevenLabs audio for TTS');
          twiml.play(options.audioUrl);
        } else {
          console.log('⚠️ Falling back to Twilio voice - no ElevenLabs audio provided');
          twiml.say({
            voice: 'alice', // Twilio fallback voice
            language: language
          }, options.text || 'Hello');
        }
        break;
        
      case 'gather':
        // Play response with continuous typing effects for natural conversation
        if (options.text) {
          // Add natural typing pauses throughout conversation
          if (options.addTypingSound) {
            twiml.pause({ length: 0.5 }); // Pre-response typing pause
            console.log('⌨️ Added pre-response typing pause for natural conversation flow');
          }
          
          // Check if we have ElevenLabs audio URL, otherwise use Twilio voice as fallback
          if (options.audioUrl) {
            console.log('🎵 Using ElevenLabs audio for TTS');
            twiml.play(options.audioUrl);
          } else {
            console.log('⚠️ Falling back to Twilio voice - no ElevenLabs audio provided');
            twiml.say({
              voice: 'alice', // Twilio fallback voice
              language: language
            }, options.text);
          }
        }
        
        // Add post-response typing effect for continuous natural ambiance
        if (options.addTypingSound) {
          twiml.pause({ length: 0.5 }); // Post-response typing pause
          console.log('✨ Added post-response typing pause for ongoing natural conversation ambiance');
        }
        
        // Record user response for OpenAI Whisper processing
        twiml.record({
          timeout: 10, // Give user time to speak
          transcribe: false, // We'll use OpenAI Whisper instead
          recordingStatusCallback: options.recordingCallback || '/api/calls/recording-complete',
          recordingStatusCallbackMethod: 'POST',
          playBeep: false, // No beep sound
          action: options.action || '/api/calls/process-speech', // Continue to next action
          method: 'POST'
        });
        
        // Fallback if no speech detected
        twiml.say({
          voice: 'alice', // Always use Twilio for fallback messages
          language: language
        }, "I didn't catch that. Let me continue.");
        break;
        
      case 'hangup':
        if (options.text) {
          // Check if we have ElevenLabs audio URL, otherwise use Twilio voice as fallback
          if (options.audioUrl) {
            console.log('🎵 Using ElevenLabs audio for hangup message');
            twiml.play(options.audioUrl);
          } else {
            console.log('⚠️ Falling back to Twilio voice for hangup - no ElevenLabs audio provided');
            twiml.say({
              voice: 'alice', // Twilio fallback voice
              language: language
            }, options.text);
          }
        }
        twiml.hangup();
        break;
    }

    return twiml.toString();
  }

  // Send WhatsApp message via Twilio
  async sendWhatsAppMessage(
    whatsappNumber: string,
    message: string
  ): Promise<{ success: boolean; messageSid?: string; error?: string }> {
    try {
      const fromNumber = `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;
      const toNumber = whatsappNumber.startsWith('whatsapp:') 
        ? whatsappNumber 
        : `whatsapp:${whatsappNumber}`;

      const messageResponse = await this.client.messages.create({
        body: message,
        from: fromNumber,
        to: toNumber
      });

      return {
        success: true,
        messageSid: messageResponse.sid
      };
    } catch (error) {
      console.error('Error sending WhatsApp message:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Export singleton instance
export const twilioService = new TwilioService();