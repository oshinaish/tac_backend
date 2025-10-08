const { DocumentProcessorServiceClient } = require('@google-cloud/documentai');
const { google } = require('googleapis');
const cors = require('cors');

// --- CONFIGURATION (Loaded from Vercel Environment Variables) ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PROCESSOR_ID = process.env.DOCAI_PROCESSOR_ID;
const GOOGLE_PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.DOCAI_LOCATION || 'us'; // e.g., 'us' or 'eu'

// Credentials for Google APIs (Service Account JSON)
const SERVICE_ACCOUNT_KEY = JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON);

// Sheets API Range
const SHEET_RANGE = 'DemandLog!A:D'; 

// Initialize Document AI Client
const docaiClient = new DocumentProcessorServiceClient({
    credentials: SERVICE_ACCOUNT_KEY
});

// Initialize Google Sheets API Client
const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// Mapping of all your fixed item names (used for filtering OCR results)
const FIXED_ITEM_LIST = [
    // Consolidated List from your demand sheets
    "Sambhar", "Red Chutney", "Dosa Batter", "Idli Batter", "Vada Batter", "Rawa mix", "Onion masala",
    "Upma Sooji", "Garlic Paste", "Podi Masala", "Sugar", "Poha", "Besan", "Sarson (Mustard seed)",
    "Kali Mirch", "Jeera", "Kaju", "Pineapple Halwa", "Kacha Peanut Chilke wala", "Dhania Whole", 
    "Rice", "Atta", "Fortune Refined", "Desi Ghee", "Roasted Chana", "Staff Dal", "Whole red chilli", 
    "Achar", "Chhole", "Rajma", "Chana Dal", "Sarson Tel", "Meetha Soda", "Roasted Peanuts", 
    "Soya Badi", "Filter Coffee Pow.", "Chai Patti", "Onions", "Tomatoes", "Green Chillies(Hari Mirch)", 
    "Coriander leaves(Dhaniya Patta)", "Curry Leaves (Kari Patta)", "Banana Leaves(Kela Patta)", 
    "Ginger", "Coconut Crush", "Carrot", "Beans", "Potato(aloo)", "Garlic", "Mint(Pudina)", "Lemon", 
    "Staff Veg.", "Deggi Mirch", "Garam Masala", "Hing Powder", "Dhania Powder", "Kitchen King", 
    "Chat Masala", "Haldi Powder", "Hari Ilaychi", "Tata Salt", "Black Salt", "50ML Container", 
    "100ML Container", "250ML Container", "300ML Container", "500ML Container", "Podi Idli Container", 
    "Silver container", "Vada Lifafa", "Dosa Box Small", "Dosa Box Big", "16*20 Biopolythene", 
    "13*16 Biopolythene", "Bio Garbagebag Big Size", "Printer Roll", "Bio Spoon", "Wooden Plates", 
    "Paper Bowl", "Filter Coffee Glass", "Masala Chhachh Glass", "Filter Coffee Packaging", 
    "Masala Chhachh Packaging", "Tape", "Clean Wrap", "Tissues", "Chef Cap", "Butter Paper", 
    "Delivery Bag"
];


// Helper to extract text from Document AI text anchor
function getTextFromSpan(document, textAnchor) {
    if (!textAnchor || !textAnchor.textSegments) return "";
    
    const start = textAnchor.textSegments[0].startIndex || 0;
    const end = textAnchor.textSegments[textAnchor.textSegments.length - 1].endIndex || 0;
    
    return document.text.substring(start, end);
}

// Core OCR and data extraction logic
function extractDemandData(document, storeId, submissionDate) {
    const extractedRows = [];

    if (document.pages && document.pages.length > 0) {
        // Iterate over all tables found (your template has multiple sections/tables)
        for (const page of document.pages) {
            if (page.tables) {
                for (const table of page.tables) {
                    for (const row of table.bodyRows) {
                        // Assuming the structure is: [S. No., Item, Unit, Required Qty]
                        if (row.cells && row.cells.length >= 4) {
                            const itemCell = row.cells[1]; // Item Name is index 1
                            const qtyCell = row.cells[3]; // Required Qty is index 3

                            // Extract text
                            const itemText = getTextFromSpan(document, itemCell.layout.textAnchor);
                            const qtyText = getTextFromSpan(document, qtyCell.layout.textAnchor);
                            
                            const itemName = itemText.trim();
                            // We are only interested in numbers written by the user
                            const quantity = qtyText.trim().replace(/\D/g, ''); 

                            if (FIXED_ITEM_LIST.includes(itemName) && quantity) {
                                extractedRows.push([
                                    submissionDate,
                                    storeId,
                                    itemName,
                                    quantity // Keeping it as a string here for Sheets to interpret
                                ]);
                            }
                        }
                    }
                }
            }
        }
    }
    return extractedRows;
}


// Vercel Serverless Function handler
module.exports = async (req, res) => {
    // Configure CORS for security
    await new Promise((resolve) => {
        cors({
            methods: ['POST'],
            origin: process.env.FRONTEND_URL || '*', // Restrict this to your Vercel frontend URL in production
        })(req, res, resolve);
    });

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { storeId, date, image, filename } = req.body;

    if (!storeId || !date || !image) {
        return res.status(400).json({ error: 'Missing storeId, date, or image data in request body.' });
    }

    const processorPath = docaiClient.processorPath(GOOGLE_PROJECT_ID, LOCATION, PROCESSOR_ID);

    // 1. DOCUMENT AI PROCESSING (OCR/Extraction)
    try {
        const document = {
            content: image, // Base64 image data
            mimeType: 'image/jpeg', 
        };

        const [result] = await docaiClient.processDocument({
            name: processorPath,
            document: document,
        });
        
        const newDemandRows = extractDemandData(result.document, storeId, date);

        if (newDemandRows.length === 0) {
            return res.status(200).json({ status: "warning", message: "Successfully processed image, but no recognizable quantities were found.", rows_added: 0 });
        }

        // 2. GOOGLE SHEETS UPDATE
        const updateResult = await sheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: SHEET_RANGE,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: newDemandRows },
        });

        const rowsAppended = updateResult.data.updates.updatedRows || 0;
        
        return res.status(200).json({
            status: "success",
            message: `Successfully processed demand. ${rowsAppended} item rows appended to Google Sheet.`,
            rows_added: rowsAppended
        });

    } catch (error) {
        console.error('Full Submission Error:', error);
        return res.status(500).json({ 
            status: "error", 
            message: 'A critical error occurred during OCR or Sheets update.',
            details: error.message 
        });
    }
};
