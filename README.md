Daily Demand OCR Submission App
This repository contains the front-end (HTML) and serverless back-end (Node.js API) for automating the conversion of handwritten demand sheets into Google Sheets data using Vercel and Google Cloud Document AI.

Project Structure
Your GitHub repository should follow this simple structure:

/
|-- demand_uploader.html  <-- Your main frontend page
|-- package.json          <-- Node.js dependencies for the API
|-- README.md             <-- This file
|-- api/
|   |-- submit.js         <-- The Vercel Serverless Function (API endpoint)

1. Google Cloud Prerequisites
Before deploying to Vercel, you need to set up the following resources in your Google Cloud Project:

A. Enable APIs
Navigate to the Google Cloud Console and ensure these two APIs are enabled for your project:

Cloud Document AI API

Google Sheets API

B. Create Document AI Processor
Go to the Document AI section.

Create a new processor. We recommend using a Form Parser (or training a Custom Extractor for maximum accuracy with your specific template).

Note down the following values for Vercel Environment Variables:

Processor ID (DOCAI_PROCESSOR_ID)

Project ID (GCP_PROJECT_ID)

Processor Location (e.g., us, eu) (DOCAI_LOCATION)

C. Create Google Service Account Key (for Security)
This key allows Vercel to securely access your Google Cloud resources.

Go to IAM & Admin -> Service Accounts.

Create a new Service Account (e.g., vercel-ocr-service).

Grant this Service Account the following IAM Roles:

Document AI Reader (for running the OCR processor)

Service Account Token Creator (if required for certain authentications)

Go to Keys for the new service account, click Add Key -> Create new key, and select JSON. Download this file.

Important: The entire content of this JSON file will be used as the value for the SERVICE_ACCOUNT_KEY_JSON environment variable in Vercel.

2. Google Sheets Setup
Create Sheet: Create your master Google Sheet (e.g., "Daily Demand Log"). Ensure the first columns are set up to receive the data in this order: Date, Store ID, Item Name, Quantity.

Share Permissions: CRITICALLY IMPORTANT: You must share the Google Sheet with the Service Account email address you created in the step above, granting it Editor permissions.

Note Sheet ID: Note the spreadsheet ID from the URL (e.g., https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID_HERE/edit). This is the value for the SPREADSHEET_ID environment variable.

3. Vercel Deployment and Environment Variables
After pushing the code to GitHub and linking the repository to Vercel, you must configure the following Environment Variables in your Vercel project settings (under Settings -> Environment Variables):

Variable Name

Description

Value Example / Source

SPREADSHEET_ID

The unique ID of your Google Sheet URL.

(From Step 2.3)

DOCAI_PROCESSOR_ID

The short ID of the Document AI processor you created.

(From Step 1.B)

GCP_PROJECT_ID

Your Google Cloud Project ID.

(From Step 1.B)

DOCAI_LOCATION

The region your processor is hosted in (e.g., us).

(From Step 1.B)

SERVICE_ACCOUNT_KEY_JSON

PASTE THE ENTIRE CONTENTS of the JSON key file here.

(From Step 1.C)

Once these variables are set, Vercel will automatically redeploy the Serverless Function (api/submit.js), and your application will be ready to process images!
