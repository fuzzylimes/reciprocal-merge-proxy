import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import fetch from 'node-fetch';

// Interface for the request payload
interface ProxyRequest {
  cookie: string;
  dea: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Get allowed origin from environment variable
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

  // Default CORS headers to include in all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle OPTIONS preflight request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Max-Age': '86400' // 24 hours
      },
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Parse request body
    const body: ProxyRequest = JSON.parse(event.body || '{}');
    const { cookie, dea } = body;

    // Validate inputs
    if (!cookie || !dea) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }

    // Sanitize DEA number (basic validation)
    const sanitizedDea = dea.replace(/[^a-zA-Z0-9]/g, '');

    // Prepare the request to API
    const postData = `helpmode=off&Database=Practitioner&quickSearch=&postHsiId=&postSourceId=&postSourceType=&singleSearch=&postSearchKey=&sUniverseSource=HCP-SLN&license=${sanitizedDea}&licdea_criteria=EM&last_name=&lastname_criteria=SW&first_name=&firstname_criteria=SW&middle_name=&middlename_criteria=SW&selState=States&hdnState=States&hdnSelBac=&hdnProfDesigAma=&hdnSelTaxonomyDescr=&hdnSelProfDesig=&hdnSelBestStatus=&sActiveLicense=&street_address=&street_address_criteria=SW&city=&city_criteria=SW&sAddressState=&license_zip=&hdnSelSanctionSource=&medproid=&medpromasterid=&hospital_name=&hospital_name_criteria=SW&group_practice=&group_practice_criteria=SW&customerid=&selSearchType=&SearchText2=&sSpecialty=&txtExpiresAfter=&sSamp=&sCertType=&sPrimSecSpecialty=&sTaxonomyCodeDescr=&sTaxonomyCode=&sSubset=&sRecordType=&sClassOfTradeDescr=&sClassOfTradeCode=&advsearch=inline&txtDetailCopy=`;

    // Call API
    const response = await fetch('https://www.medproid.com/WebID.asp?action=DeaQuery&advquery=inline&Database=Practitioner&resetQS=N', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie
      },
      body: postData
    });

    // Handle potential redirects
    if (response.status === 301 || response.status === 302) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Redirect response from API',
          status: response.status,
          location: response.headers.get('location')
        })
      };
    }

    // Get response text
    const responseText = await response.text();

    // Return successful response with the HTML
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html'
      },
      body: responseText
    };
  } catch (error) {
    // Log error but don't expose details to client
    console.error('Error:', error);

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Failed to fetch data from API',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
