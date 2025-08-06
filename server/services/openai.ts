import OpenAI from "openai";
import { storage } from '../storage';
import type { Campaign } from '@shared/schema';

const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_SECRET_KEY;

if (!apiKey) {
  throw new Error('OpenAI API key not found. Please set OPENAI_API_KEY environment variable.');
}

const openai = new OpenAI({ apiKey });

export interface ConversationContext {
  campaignPrompt: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  contactName?: string;
  phoneNumber: string;
}

export interface AIResponse {
  message: string;
  shouldEndCall: boolean;
  extractedData?: Record<string, any>;
  responseTime: number;
}

export class OpenAIService {
  async generateResponse(context: ConversationContext, userInput: string): Promise<AIResponse> {
    const startTime = Date.now();

    try {
      // Create dynamic conversation state-based prompt
      const conversationHistory = context.conversationHistory;
      const isFirstMessage = conversationHistory.length === 0;
      
      let conversationState = "greeting";
      if (conversationHistory.length > 0) {
        const lastResponse = conversationHistory[conversationHistory.length - 1];
        if (lastResponse.content.includes("WhatsApp") || lastResponse.content.includes("number")) {
          conversationState = "collecting_whatsapp";
        } else if (lastResponse.content.includes("email") || lastResponse.content.includes("Email")) {
          conversationState = "collecting_email";
        } else if (lastResponse.content.includes("thank") || lastResponse.content.includes("Thank")) {
          conversationState = "closing";
        }
      }

      const systemPrompt = `You are Aavika from LabsCheck platform calling to discuss lab partnership opportunities.

ABOUT LABSCHECK:
LabsCheck is a healthcare platform founded in 2025 on a mission to make diagnostic healthcare in India transparent and user-friendly.

BUSINESS MODEL & MISSION:
- LabsCheck is NOT a laboratory - we're a neutral aggregator platform
- We don't collect samples, perform tests, or charge commissions
- Our goal: Partner with ALL laboratories across India to create transparency
- Mission: Bridge the gap between people seeking tests and labs offering diagnostics
- Zero middleman cost, full transparency, total convenience

WHAT WE DO:
- Connect users to NABL-accredited/ICMR certified labs across 140+ Indian cities
- Help labs get more customers through our platform
- Provide real-time pricing comparison with no hidden charges
- Enable online booking with location-based lab discovery
- We're like a personal health-check assistant - always available, always transparent

CURRENT STATUS (2025):
- Over 500+ labs listed on platform
- 100k+ users trust us to find best lab deals
- Partnered with top-tier diagnostic providers across India
- Featured in healthcare publications for innovation
- All partner labs are verified and certified

LAB PARTNERSHIP OPPORTUNITY:
- Join 500+ labs already on our platform
- Get direct customer bookings with zero commission
- Transparent pricing helps customers choose you
- Location-based discovery brings nearby customers
- No hidden fees - what customers see is what they pay you directly

POPULAR TESTS ON PLATFORM:
- Blood Glucose (Fasting) - Starting ₹180
- Hemoglobin Test - Starting ₹200  
- ESR Test - Starting ₹250
- Thyroid (TSH) - Starting ₹350
- Complete Blood Count (CBC) - Starting ₹400
- Vitamin D - Starting ₹800

PARTNER LABS: Dr Lal PathLabs, Thyrocare, Metropolis, Apollo Diagnostics, Redcliffe Labs, Pathkind, and 500+ more

WEBSITE: labscheck.com

CUSTOMER SAID (may have speech recognition errors): "${userInput}"

SPEECH PATTERN UNDERSTANDING:
- "hay I bi ka what ise D App se ware r u call ine from" = "Hello, I want to know what is this app and where are you calling from"
- "abhi kam Lenge tab about u" = "I'm busy now, will take details later about you"
- Broken English/Hindi mix is common due to phone quality

CRITICAL: YOU ARE CALLING LAB OWNERS FOR PARTNERSHIP RECRUITMENT, NOT SELLING TESTS TO PATIENTS!

CONTEXT UNDERSTANDING - When customer says:
- "कम रेट" / "cheap rates" → They want to know about partnership commission rates (ZERO commission!)
- "रेट क्या है" / "what are rates" → They're asking about partnership terms (FREE listing!)
- "कितना पैसा" / "how much money" → They want to know costs (NO cost to join!)
- "क्या फायदा" / "what benefit" → Explain more customers, direct bookings, zero commission

PARTNERSHIP RECRUITMENT RESPONSES:
- Rate/Cost questions → "Bilkul free hai sir, zero commission! Aapko 100% payment direct milta hai customers se. Aap lab owner hain?"
- Benefits questions → "Zyada customers milenge, direct booking, no middleman. 500+ labs already joined. Aap pathology lab chalate hain?"
- What is this → "LabsCheck platform hai jo labs ko customers connect karta hai. Aapka lab hai? Free mein list kar sakte hain."
- General confusion → "Main labs ke saath partnership ke liye call kar rahi hun. Aap lab business mein hain?"

REMEMBER: Focus on LAB PARTNERSHIP BENEFITS, not patient test prices!

CONVERSATION RULES:
- UNDERSTAND customer is asking about LAB PARTNERSHIP, not patient services
- RESPOND to their partnership-related concerns (rates = commission, benefits = more customers)
- BE CLEAR about zero commission and free listing benefits
- ALWAYS position yourself as recruiting LABS as partners, not selling to patients
- ASK if they run a lab/pathology business to qualify them
- KEEP responses FOCUSED on partnership benefits (2-3 sentences max)

Extract any useful information mentioned during the conversation and format it as JSON in your response.

Respond with a JSON object:
{
  "message": "Your natural Hinglish response that directly addresses what they said",
  "shouldEndCall": false,
  "extractedData": {
    "whatsapp_number": "value if mentioned",
    "email": "value if mentioned", 
    "contact_complete": "yes/no - yes when you have both WhatsApp and email",
    "customer_interest": "interested/not_interested/neutral",
    "notes": "exact quote of what customer said"
  }
}`;

      // Natural conversation flow - let AI understand customer directly
      const messages = [
        { role: "system" as const, content: systemPrompt },
        ...context.conversationHistory.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })),
        { role: "user" as const, content: userInput }
      ];

      // Use fast model for sub-2s response time
      const model = "gpt-4o-mini"; // Fastest model for under 2s response
      console.log(`🧠 [AI] Model: ${model} | Input: "${userInput}"`);
      
      const response = await openai.chat.completions.create({
        model,
        messages,
        response_format: { type: "json_object" },
        max_tokens: 120, // Optimized for speed while maintaining context
        temperature: 0.05, // Minimal randomness for fastest consistent responses
      });

      const responseTime = Date.now() - startTime;
      const aiResponse = JSON.parse(response.choices[0].message.content || '{}');

      return {
        message: aiResponse.message || "I'm sorry, could you repeat that?",
        shouldEndCall: aiResponse.shouldEndCall || false,
        extractedData: aiResponse.extractedData || {},
        responseTime,
      };
    } catch (error: any) {
      console.error('Error generating AI response:', error);
      const responseTime = Date.now() - startTime;
      
      // Handle quota errors with contextual conversation system
      if (error.status === 429 || error.code === 'insufficient_quota') {
        console.log('OpenAI quota exceeded - using contextual conversation logic');
        
        // CONTEXTUAL CONVERSATION SYSTEM - responds based on what customer actually said
        const customerSaid = userInput.toLowerCase();
        let response = "";
        let shouldEndCall = false;
        let extractedData: Record<string, any> = {};
        
        // Response logic based on customer's exact words
        if (customerSaid.includes("fine") || customerSaid.includes("good") || customerSaid.includes("theek") || customerSaid.includes("accha")) {
          response = "Great! Can you share your WhatsApp number?";
          extractedData.customer_interest = "interested";
        } 
        else if (customerSaid.includes("what") || customerSaid.includes("why") || customerSaid.includes("kya") || customerSaid.includes("kyon")) {
          response = "We want to share our lab test details with you";
          extractedData.customer_interest = "neutral";
        }
        else if (customerSaid.match(/\d{10}/)) { // Phone number detected
          const phoneMatch = customerSaid.match(/\d{10}/);
          response = "Perfect! Now can you share your email ID?";
          extractedData.whatsapp_number = phoneMatch ? phoneMatch[0] : "";
          extractedData.customer_interest = "interested";
        }
        else if (customerSaid.includes("@") || customerSaid.includes("email") || customerSaid.includes("gmail")) {
          response = "Thank you! We'll send you the details soon";
          extractedData.email = userInput.match(/\S+@\S+\.\S+/)?.[0] || "provided";
          extractedData.contact_complete = "yes";
          shouldEndCall = true;
        }
        else if (customerSaid.includes("not interested") || customerSaid.includes("no") || customerSaid.includes("nahi")) {
          response = "No problem. Have a good day!";
          extractedData.customer_interest = "not_interested";
          shouldEndCall = true;
        }
        else {
          // Default response for unclear input
          response = "Can you share your WhatsApp number for lab details?";
          extractedData.customer_interest = "neutral";
        }
        
        extractedData.notes = `Customer said: "${userInput}"`;
        
        return {
          message: response,
          shouldEndCall,
          extractedData,
          responseTime,
        };
      }
      
      return {
        message: "Sorry sir, thoda technical issue hai. Main dubara call karunga. Dhanyawad!",
        shouldEndCall: true,
        extractedData: {
          notes: "Technical error - Hindi farewell provided"
        },
        responseTime,
      };
    }
  }

  async generateConversationSummary(messages: Array<{ role: string; content: string }>): Promise<string> {
    try {
      const conversationText = messages
        .map(msg => `${msg.role === 'user' ? 'Customer' : 'Agent'}: ${msg.content}`)
        .join('\n');

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "Summarize this conversation between an AI agent and a customer. Focus on key points discussed, information collected, and the overall outcome. Keep it concise but comprehensive."
          },
          {
            role: "user",
            content: conversationText
          }
        ],
        max_tokens: 200,
      });

      return response.choices[0].message.content || "No summary available";
    } catch (error: any) {
      console.error('Error generating conversation summary:', error);
      
      // Handle quota errors gracefully
      if (error.status === 429 || error.code === 'insufficient_quota') {
        return "Call completed successfully. Summary temporarily unavailable due to service limits.";
      }
      
      return "Call completed successfully. Summary generation failed.";
    }
  }

  async calculateSuccessScore(extractedData: Record<string, any>, campaignObjectives: string): Promise<number> {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `Rate the success of this call on a scale of 1-100 based on how well it achieved the campaign objectives. Consider the quality and completeness of data collected. Respond with just a number between 1 and 100.`
          },
          {
            role: "user",
            content: `Campaign Objectives: ${campaignObjectives}\n\nData Collected: ${JSON.stringify(extractedData)}`
          }
        ],
        max_tokens: 10,
      });

      const score = parseInt(response.choices[0].message.content || "50");
      return Math.max(1, Math.min(100, score));
    } catch (error: any) {
      console.error('Error calculating success score:', error);
      
      // Handle quota errors gracefully
      if (error.status === 429 || error.code === 'insufficient_quota') {
        console.log('OpenAI quota exceeded - using default success score of 75');
        return 75; // Default success score when quota exceeded
      }
      
      return 50; // Default moderate score for other errors
    }
  }
}

export const openaiService = new OpenAIService();
