/**
 * YouTube Subscription Transfer Tool
 * Complete Backend Logic - Google Apps Script
 * Version: 2.5 (Fixed Account Switcher)
 */

// Serves the HTML interface
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('YouTube Subscription Transfer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Gets current user information
 * @return {object} User information
 */
function getCurrentUser() {
  try {
    const email = Session.getActiveUser().getEmail();
    
    // Try to get YouTube channel info for better display
    try {
      const channel = YouTube.Channels.list('snippet,statistics', {
        mine: true,
        maxResults: 1
      });
      
      if (channel.items && channel.items.length > 0) {
        return {
          success: true,
          email: email,
          channelName: channel.items[0].snippet.title,
          channelId: channel.items[0].id,
          subscriberCount: channel.items[0].statistics.subscriberCount || 'N/A',
          thumbnailUrl: channel.items[0].snippet.thumbnails.default.url
        };
      }
    } catch (ytError) {
      // YouTube channel fetch failed, return just email
      Logger.log('Could not fetch YouTube channel: ' + ytError.message);
    }
    
    return {
      success: true,
      email: email,
      channelName: null,
      channelId: null
    };
    
  } catch (error) {
    Logger.log('Get current user error: ' + error.message);
    return {
      success: false,
      error: 'Could not retrieve user information'
    };
  }
}

/**
 * Exports current user's YouTube subscriptions to a Google Sheet
 * @return {object} Response with sheet URL and channel count
 */
function exportSubscriptionsToSheet() {
  try {
    Logger.log('Starting export process...');
    
    // Get user's subscriptions with timeout protection
    let subscriptions = [];
    let nextPageToken = '';
    let pageCount = 0;
    const maxPages = 20; // Limit to 1000 subscriptions (50 per page)
    
    do {
      try {
        const response = YouTube.Subscriptions.list('snippet', {
          mine: true,
          maxResults: 50,
          pageToken: nextPageToken
        });
        
        if (response.items && response.items.length > 0) {
          subscriptions = subscriptions.concat(response.items);
          Logger.log('Fetched page ' + (pageCount + 1) + ': ' + response.items.length + ' items');
        }
        
        nextPageToken = response.nextPageToken;
        pageCount++;
        
        // Prevent timeout for very large subscription lists
        if (pageCount >= maxPages) {
          Logger.log('Reached page limit, stopping pagination');
          break;
        }
        
      } catch (apiError) {
        Logger.log('API Error on page ' + pageCount + ': ' + apiError.message);
        break;
      }
      
    } while (nextPageToken);
    
    Logger.log('Total subscriptions fetched: ' + subscriptions.length);
    
    if (subscriptions.length === 0) {
      return { success: false, error: 'No subscriptions found in your account. Make sure you have subscribed to some YouTube channels.' };
    }
    
    // Create new spreadsheet
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm');
    const sheetName = 'YT_Subs_' + timestamp;
    
    Logger.log('Creating spreadsheet: ' + sheetName);
    const sheet = SpreadsheetApp.create(sheetName);
    const activeSheet = sheet.getActiveSheet();
    const sheetId = sheet.getId();
    
    // Set headers
    activeSheet.getRange('A1:C1').setValues([['Channel ID', 'Channel Name', 'Channel URL']]);
    activeSheet.getRange('A1:C1').setFontWeight('bold').setBackground('#4285f4').setFontColor('#ffffff');
    
    // Add subscription data in batches to avoid timeout
    const batchSize = 100;
    for (let i = 0; i < subscriptions.length; i += batchSize) {
      const batch = subscriptions.slice(i, i + batchSize);
      const data = batch.map(sub => [
        sub.snippet.resourceId.channelId,
        sub.snippet.title,
        'https://youtube.com/channel/' + sub.snippet.resourceId.channelId
      ]);
      
      const startRow = i + 2; // +2 because row 1 is header
      activeSheet.getRange(startRow, 1, data.length, 3).setValues(data);
      Logger.log('Wrote batch ' + Math.floor(i / batchSize + 1) + ': rows ' + startRow + ' to ' + (startRow + data.length - 1));
    }
    
    // Format sheet
    Logger.log('Formatting sheet...');
    activeSheet.autoResizeColumns(1, 3);
    activeSheet.setFrozenRows(1);
    
    // Share the sheet with anyone with link
    Logger.log('Setting sharing permissions...');
    try {
      const file = DriveApp.getFileById(sheetId);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      Logger.log('Sharing permissions set successfully');
    } catch (shareError) {
      Logger.log('Warning: Could not set sharing permissions: ' + shareError.message);
      // Continue anyway - user can manually share
    }
    
    Logger.log('Export completed successfully');
    
    return { 
      success: true, 
      sheetUrl: sheet.getUrl(),
      sheetId: sheetId,
      count: subscriptions.length,
      duplicates: 0
    };
    
  } catch (error) {
    Logger.log('Export failed: ' + error.message);
    Logger.log('Stack trace: ' + error.stack);
    
    // Provide more helpful error messages
    let userMessage = error.message;
    
    if (error.message.includes('server error')) {
      userMessage = 'Server timeout. Try again in a few minutes. If you have many subscriptions (500+), this feature may take multiple attempts.';
    } else if (error.message.includes('Authorization')) {
      userMessage = 'Authorization error. Please re-authorize the app and try again.';
    } else if (error.message.includes('quota')) {
      userMessage = 'YouTube API quota exceeded. Please try again tomorrow.';
    }
    
    return { 
      success: false, 
      error: userMessage
    };
  }
}

/**
 * Copies a shared sheet to user's Drive and adds their subscriptions
 * @param {string} sourceSheetId - The source sheet ID to copy from
 * @return {object} Response with new sheet details
 */
function copyAndAppendToSheet(sourceSheetId) {
  try {
    Logger.log('Starting copy and append process...');
    
    // Get user's subscriptions
    let subscriptions = [];
    let nextPageToken = '';
    let pageCount = 0;
    const maxPages = 20;
    
    do {
      try {
        const response = YouTube.Subscriptions.list('snippet', {
          mine: true,
          maxResults: 50,
          pageToken: nextPageToken
        });
        
        if (response.items && response.items.length > 0) {
          subscriptions = subscriptions.concat(response.items);
        }
        
        nextPageToken = response.nextPageToken;
        pageCount++;
        
        if (pageCount >= maxPages) break;
        
      } catch (apiError) {
        Logger.log('API Error: ' + apiError.message);
        break;
      }
      
    } while (nextPageToken);
    
    Logger.log('Fetched ' + subscriptions.length + ' subscriptions');
    
    if (subscriptions.length === 0) {
      return { success: false, error: 'No subscriptions found in your account' };
    }
    
    // Copy the source sheet
    Logger.log('Copying source sheet: ' + sourceSheetId);
    const sourceFile = DriveApp.getFileById(sourceSheetId);
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm');
    const copiedFile = sourceFile.makeCopy('YT_Subs_Copy_' + timestamp);
    const copiedSheetId = copiedFile.getId();
    const sheet = SpreadsheetApp.openById(copiedSheetId);
    const activeSheet = sheet.getSheets()[0];
    
    // Get existing data to avoid duplicates
    Logger.log('Checking for duplicates...');
    const lastRow = activeSheet.getLastRow();
    const existingData = lastRow > 1 ? activeSheet.getRange('A2:A' + lastRow).getValues() : [];
    const existingIds = existingData.flat().filter(id => id);
    
    Logger.log('Found ' + existingIds.length + ' existing channel IDs');
    
    // Filter out duplicates
    const newSubs = subscriptions.filter(sub => 
      !existingIds.includes(sub.snippet.resourceId.channelId)
    );
    
    Logger.log('New unique subscriptions to add: ' + newSubs.length);
    
    if (newSubs.length > 0) {
      // Append new subscriptions in batches
      const batchSize = 100;
      let currentRow = lastRow + 1;
      
      for (let i = 0; i < newSubs.length; i += batchSize) {
        const batch = newSubs.slice(i, i + batchSize);
        const data = batch.map(sub => [
          sub.snippet.resourceId.channelId,
          sub.snippet.title,
          'https://youtube.com/channel/' + sub.snippet.resourceId.channelId
        ]);
        
        activeSheet.getRange(currentRow, 1, data.length, 3).setValues(data);
        currentRow += data.length;
        Logger.log('Appended batch starting at row ' + (currentRow - data.length));
      }
      
      activeSheet.autoResizeColumns(1, 3);
    }
    
    // Share the copied sheet
    Logger.log('Setting sharing permissions...');
    try {
      copiedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (shareError) {
      Logger.log('Warning: Could not set sharing: ' + shareError.message);
    }
    
    Logger.log('Copy and append completed successfully');
    
    return { 
      success: true, 
      sheetUrl: sheet.getUrl(),
      sheetId: copiedSheetId,
      count: subscriptions.length,
      newCount: newSubs.length,
      duplicates: subscriptions.length - newSubs.length
    };
    
  } catch (error) {
    Logger.log('Copy and append failed: ' + error.message);
    
    let userMessage = error.message;
    
    if (error.message.includes('server error')) {
      userMessage = 'Server timeout. Try again in a few minutes.';
    } else if (error.message.includes('not found')) {
      userMessage = 'Source sheet not found. Make sure the Sheet ID is correct and the sheet is shared.';
    }
    
    return { 
      success: false, 
      error: userMessage
    };
  }
}

/**
 * Gets current user's subscription count (for display)
 * @return {object} Subscription count
 */
function getSubscriptionCount() {
  try {
    const response = YouTube.Subscriptions.list('id', {
      mine: true,
      maxResults: 1
    });
    
    return { 
      success: true, 
      count: response.pageInfo ? response.pageInfo.totalResults : 0 
    };
  } catch (error) {
    Logger.log('Get subscription count error: ' + error.message);
    return { success: false, count: 0 };
  }
}

/**
 * Fetches channel IDs from a Google Sheet
 * @param {string} spreadsheetId - The ID of the Google Sheet
 * @return {object} Response with channel IDs or error
 */
function fetchFromSheet(spreadsheetId) {
  try {
    Logger.log('Fetching from sheet: ' + spreadsheetId);
    
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
    const lastRow = sheet.getLastRow();
    
    if (lastRow < 2) {
      return { success: false, error: 'Sheet is empty or has no data rows' };
    }
    
    const data = sheet.getRange('A2:A' + lastRow).getValues();
    
    // Filter out empty cells and headers
    const channelIds = data
      .flat()
      .filter(id => id && id.toString().trim().length > 0)
      .filter(id => {
        const str = id.toString();
        return str.startsWith('UC') || str.startsWith('HC');
      })
      .map(id => id.toString().trim());
    
    Logger.log('Found ' + channelIds.length + ' valid channel IDs');
    
    if (channelIds.length === 0) {
      return { success: false, error: 'No valid Channel IDs found in column A. Make sure they start with UC or HC.' };
    }
    
    return { success: true, channelIds: channelIds, count: channelIds.length };
    
  } catch (error) {
    Logger.log('Fetch from sheet error: ' + error.message);
    
    let userMessage = error.message;
    
    if (error.message.includes('not found')) {
      userMessage = 'Sheet not found. Check the Sheet ID and make sure it is shared with "Anyone with the link".';
    } else if (error.message.includes('Permission denied')) {
      userMessage = 'Permission denied. The sheet must be shared with "Anyone with the link" (view access).';
    }
    
    return { 
      success: false, 
      error: userMessage
    };
  }
}

/**
 * Subscribes to a single YouTube channel
 * @param {string} channelId - The channel ID to subscribe to
 * @return {object} Response with success status and message
 */
function subscribeToChannel(channelId) {
  try {
    // Create subscription resource
    const resource = {
      snippet: {
        resourceId: {
          kind: 'youtube#channel',
          channelId: channelId
        }
      }
    };
    
    // Call YouTube API to subscribe
    YouTube.Subscriptions.insert(resource, 'snippet');
    
    return { 
      success: true, 
      channelId: channelId,
      message: 'Successfully subscribed' 
    };
    
  } catch (error) {
    // Handle specific error cases
    const errorMessage = error.message || error.toString();
    
    if (errorMessage.includes('subscriptionDuplicate')) {
      return { 
        success: false, 
        channelId: channelId,
        error: 'Already subscribed',
        skippable: true 
      };
    }
    
    if (errorMessage.includes('quotaExceeded')) {
      return { 
        success: false, 
        channelId: channelId,
        error: 'API Quota exceeded. Try again tomorrow.',
        critical: true 
      };
    }
    
    if (errorMessage.includes('channelNotFound') || errorMessage.includes('forbidden')) {
      return { 
        success: false, 
        channelId: channelId,
        error: 'Channel not found or unavailable',
        skippable: true 
      };
    }
    
    return { 
      success: false, 
      channelId: channelId,
      error: errorMessage 
    };
  }
}

/**
 * Gets shareable template message
 * @param {string} sheetUrl - The sheet URL
 * @param {number} count - Number of subscriptions
 * @return {string} Template message
 */
function getShareMessage(sheetUrl, count) {
  try {
    const appUrl = ScriptApp.getService().getUrl();
    
    // Extract sheet ID from URL
    const sheetIdMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const sheetId = sheetIdMatch ? sheetIdMatch[1] : 'SHEET_ID';
    
    return `Hey! I've shared my YouTube subscriptions with you (${count} channels).

🔗 Google Sheet: ${sheetUrl}

To import these into your YouTube account:
1. Open: ${appUrl}
2. Click "📥 Import from Others"
3. Choose "From Google Sheet"
4. Paste this Sheet ID: ${sheetId}
5. Click "Load Channel IDs" then "Start Transfer"

You can also export your own subscriptions and share them back!`;
  } catch (error) {
    Logger.log('Get share message error: ' + error.message);
    return 'Error generating share message';
  }
}

/**
 * Gets current user's email
 * @return {string} User email
 */
function getUserEmail() {
  try {
    return Session.getActiveUser().getEmail();
  } catch (error) {
    Logger.log('Get user email error: ' + error.message);
    return '';
  }
}

/**
 * Validates a spreadsheet ID
 * @param {string} spreadsheetId - The spreadsheet ID to validate
 * @return {object} Validation result
 */
function validateSpreadsheet(spreadsheetId) {
  try {
    const sheet = SpreadsheetApp.openById(spreadsheetId);
    return { valid: true, name: sheet.getName() };
  } catch (error) {
    Logger.log('Validate spreadsheet error: ' + error.message);
    return { valid: false, error: error.message };
  }
}
