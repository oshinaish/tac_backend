import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Storage } from '@google-cloud/storage';
import { google } from 'googleapis';
import Cors from 'cors';

// --- INITIALIZATION ---
// Initialize CORS middleware
const cors = Cors({
  methods: ['POST', 'OPTIONS'],
  origin: '*', // Allow all origins for testing. Restrict this in production.
});

// Environment variables (Vercel/GCP)
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const DOCAI_PROCESSOR_ID = process.env.DOCAI_PROCESSOR_ID;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_KEY_JSON = process.env.SERVICE_ACCOUNT_KEY_JSON;

// Parse the service account key for auth
let SERVICE_ACCOUNT_KEY;
try {
    SERVICE_ACCOUNT_KEY = JSON.parse(SERVICE_ACCOUNT_KEY_JSON);
} catch (e) {
    console.error("Failed to parse SERVICE_ACCOUNT_KEY_JSON:", e);
    // Crash the serverless function if auth fails immediately
    throw new Error("Invalid SERVICE_ACCOUNT_KEY_JSON provided.");
}

// Initialize Google Cloud clients
const storage = new Storage({
    projectId: GCP_PROJECT_ID,
    credentials: {
        client_email: SERVICE_ACCOUNT_KEY.client_email,
        private_key: SERVICE_ACCOUNT_KEY.private_key.replace(/\\n/g, '\n'),
    },
});

const processorClient = new DocumentProcessorServiceClient({
    projectId: GCP_PROJECT_ID,
    credentials: {
        client_email: SERVICE_ACCOUNT_KEY.client_email,
        private_key: SERVICE_ACCOUNT_KEY.private_key.replace(/\\n/g, '\n'),
    },
});

// --- HELPER FUNCTIONS ---

// Run the CORS middleware
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

// Authenticate and get Sheets client
async function getSheetsClient() {
    const auth = new google.auth.JWT({
        email: SERVICE_ACCOUNT_KEY.client_email,
        key: SERVICE_ACCOUNT_KEY.private_key.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    await auth.authorize();
    return google.sheets({ version: 'v4', auth });
}


// --- MAIN HANDLER ---
export default async function handler(req, res) {
  // Apply CORS
  await runMiddleware(req, res, cors);

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  // Check for required input data
  const { documentName, base64File } = req.body;
  if (!documentName || !base64File) {
    return res.status(400).json({ error: 'Missing documentName or base64File in request body.' });
  }

  let gcsUri = '';
  let documentText = '';

  try {
    const dataBuffer = Buffer.from(base64File, 'base64');
    const timestamp = Date.now();
    const uniqueId = Math.random().toString(36).substring(2, 8);
    // Create a path in GCS using a folder structure for organization
    const gcsFilepath = `uploads/${documentName.replace(/[^a-z0-9]/gi, '_')}-${timestamp}-${uniqueId}.pdf`;

    // 1. UPLOAD FILE TO GCS
    const file = storage.bucket(GCS_BUCKET_NAME).file(gcsFilepath);

    console.log(`Uploading file to gs://${GCS_BUCKET_NAME}/${gcsFilepath}`);

    // UPLOAD WITHOUT LEGACY ACL OPTIONS
    await file.save(dataBuffer, {
        contentType: 'application/pdf', // Assuming PDF based on typical DocAI usage
        destination: gcsFilepath,
        // *** CRITICAL FIX: Removed predefinedAcl: 'publicRead' to fix the GCS error. ***
    });

    // MAKE FILE PUBLIC using the IAM-compliant method
    await file.makePublic(); // This is the preferred way when using Uniform Bucket-Level Access
    
    gcsUri = `gs://${GCS_BUCKET_NAME}/${gcsFilepath}`;
    const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${gcsFilepath}`;
    console.log(`File uploaded and made public. URI: ${gcsUri}`);


    // 2. PROCESS DOCUMENT WITH DOCUMENT AI
    const location = GCP_PROJECT_ID === 'your-project-id' ? 'us' : 'us'; // Defaulting to 'us' region
    const name = `projects/${GCP_PROJECT_ID}/locations/${location}/processors/${DOCAI_PROCESSOR_ID}`;

    const request = {
      name,
      rawDocument: {
        content: dataBuffer.toString('base64'),
        mimeType: 'application/pdf',
      },
    };

    console.log(`Sending document to Document AI processor: ${DOCAI_PROCESSOR_ID}`);
    const [result] = await processorClient.processDocument(request);

    // Extract text from the processed document
    documentText = result.document?.text || 'No text extracted.';

    // Extract key-value pairs (or other structured data) if a form parser is used
    let extractedData = {};
    if (result.document?.entities && result.document.entities.length > 0) {
        result.document.entities.forEach(entity => {
            extractedData[entity.type] = entity.mentionText || entity.normalizedValue?.text || '';
        });
    }

    console.log(`Document AI processing complete. Extracted Text Length: ${documentText.length}`);

    // 3. APPEND DATA TO GOOGLE SHEET
    const sheets = await getSheetsClient();
    // FIX: Updated range to 'Sheet1!A:E' to accommodate the 5 columns of data being appended.
    const sheetRange = 'Sheet1!A:E'; // Define the range to append data (A=Time, B=Name, C=URL, D=Text, E=Extracted Data)

    // Prepare data row
    const now = new Date().toISOString();
    const dataRow = [
      now,
      documentName,
      publicUrl,
      documentText.substring(0, 500) + (documentText.length > 500 ? '...' : ''), // Truncate text for sheet view
      JSON.stringify(extractedData) // Add structured data
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetRange,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [dataRow],
      },
    });

    console.log('Data successfully appended to Google Sheet.');

    // 4. FINAL SUCCESS RESPONSE
    return res.status(200).json({
      message: 'Document processed and data saved successfully.',
      gcsUrl: publicUrl,
      documentText: documentText.substring(0, 500) + (documentText.length > 500 ? '...' : ''),
      extractedData: extractedData,
    });

  } catch (error) {
    console.error('SERVERLESS FUNCTION ERROR:', error.message || error);
    // Delete the file from GCS if upload succeeded but processing failed (optional cleanup)
    if (gcsUri) {
        try {
            await storage.bucket(GCS_BUCKET_NAME).file(gcsUri.substring(`gs://${GCS_BUCKET_NAME}/`.length)).delete();
            console.log('Cleaned up partially uploaded file from GCS.');
        } catch (cleanupError) {
            console.error('Failed to clean up GCS file:', cleanupError.message);
        }
    }

    // Return a 500 status with an error message
    return res.status(500).json({
      error: 'An internal server error occurred during processing.',
      details: error.message || 'Unknown error.',
    });
  }
}
