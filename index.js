import express from 'express';
import rtms from "@zoom/rtms";
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

const activeConnections = new Map();
const monitoringRequests = new Map();

// Handle signaling connection
async function handleSignalingConnection(meetingUuid, rtmsStreamId, serverUrls) {
  try {
    const monitoringRequest = monitoringRequests.get(meetingUuid);
    if (!monitoringRequest) {
      console.log(`No active monitoring request for meeting ${meetingUuid}. Ignoring.`);
      return;
    }

    console.log(`Starting RTMS connection for meeting: ${meetingUuid}`);
    console.log(`Will monitor audio and video for user: ${monitoringRequest.userId}`);
    
    // This timeout now handles data capture AND calling the external API
    const captureTimeout = setTimeout(async () => {
      console.log(`10 seconds elapsed. Stopping RTMS for meeting: ${meetingUuid}`);
      try {
        await rtms.leave();
        console.log(`Left RTMS session for meeting: ${meetingUuid}`);

        const { audio, video } = monitoringRequests.get(meetingUuid) || { audio: [], video: [] };
        console.log(`Collected ${audio.length} audio chunks and ${video.length} video chunks.`);

        const externalApiUrl = process.env.EXTERNAL_API_URL;
        if (!externalApiUrl) {
          throw new Error('EXTERNAL_API_URL environment variable is not set.');
        }

        console.log(`Sending data to external API at ${externalApiUrl}`);
        const response = await axios.post(externalApiUrl, {
          meetingUuid,
          userId: monitoringRequest.userId,
          audio: audio.map(b => b.toString('base64')), // Encode buffers as Base64
          video: video.map(b => b.toString('base64')),
        });

        // Resolve the promise for the original /monitor request
        monitoringRequest.resolve(response.data);

      } catch (e) {
        console.error('Error during data processing or API call:', e.message);
        monitoringRequest.reject(e);
      } finally {
        activeConnections.delete(meetingUuid);
        monitoringRequests.delete(meetingUuid); // Clean up monitoring request
      }
    }, 10000);
    
    // Create the payload for RTMS
    const payload = {
      meeting_uuid: meetingUuid,
      rtms_stream_id: rtmsStreamId,
      server_urls: serverUrls
    };

    rtms.onAudioData((data, size, timestamp, metadata) => {
      const request = monitoringRequests.get(meetingUuid);
      if (request && metadata.nodeId === request.userId) {
        console.log(`${metadata.userName} (${metadata.nodeId}): ${data.length} bytes of audio data`);
        request.audio.push(data);
      }
    });

    rtms.onVideoData((data, size, timestamp, metadata) => {
      const request = monitoringRequests.get(meetingUuid);
      if (request && metadata.nodeId === request.userId) {
        console.log(`${metadata.userName} (${metadata.nodeId}): ${data.length} bytes of video data`);
        request.video.push(data);
      }
    });

    // Join the RTMS session
    await rtms.join(payload);
    
    // Store connection for cleanup
    activeConnections.set(meetingUuid, {
      rtmsStreamId,
      serverUrls,
      joinedAt: new Date()
    });
    
    console.log(`Successfully joined RTMS session for meeting: ${meetingUuid}`);
    
  } catch (error) {
    console.error(`Error handling signaling connection:`, error);
    const monitoringRequest = monitoringRequests.get(meetingUuid);
    if (monitoringRequest) {
      monitoringRequest.reject(error);
      monitoringRequests.delete(meetingUuid);
    }
    throw error;
  }
}

// check endpoint for deepfake detection
app.post('/monitor', async (req, res) => {
  const { meetingUuid, userId } = req.body;

  if (!meetingUuid || !userId) {
    return res.status(400).json({
      status: 'error',
      message: 'meetingUuid and userId are required fields.'
    });
  }

  if (monitoringRequests.has(meetingUuid)) {
    return res.status(409).json({
        status: 'error',
        message: `A monitoring session for meeting ${meetingUuid} is already active.`
    });
  }

  console.log(`Received request to monitor user ${userId} in meeting ${meetingUuid}. Waiting for webhook...`);
  
  try {
    const response = await new Promise((resolve, reject) => {
      // Set a timeout for waiting on the webhook, e.g., 60 seconds
      const webhookTimeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for meeting.rtms_started event for meeting ${meetingUuid}`));
        monitoringRequests.delete(meetingUuid);
      }, 60000);

      monitoringRequests.set(meetingUuid, { 
        userId, 
        audio: [], 
        video: [],
        resolve: (data) => {
          clearTimeout(webhookTimeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(webhookTimeout);
          reject(err);
        }
      });
    });

    // Send the successful response from the external API back to the client
    res.status(200).json(response);

  } catch (error) {
    console.error(`Monitoring failed for meeting ${meetingUuid}:`, error.message);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});


// webhook endpoint for rtms
app.post('/webhook', async (req, res) => {
  try {
    const { event, payload = {} } = req.body;
    
    console.log(`Received webhook event: ${event}`);
    
    // RTMS session starts
    if (event === 'meeting.rtms_started') {
      const meetingUuid = payload.meeting_uuid;
      
      if (monitoringRequests.has(meetingUuid)) {
        const rtmsStreamId = payload.rtms_stream_id;
        const serverUrls = payload.server_urls;
        
        console.log(`RTMS session started for monitored meeting: ${meetingUuid}`);
        
        // Start WebSocket connection asynchronously
        handleSignalingConnection(meetingUuid, rtmsStreamId, serverUrls)
          .catch(error => {
            console.error(`Failed to handle signaling connection:`, error);
          });
      } else {
        console.log(`RTMS session started for an unmonitored meeting: ${meetingUuid}. Ignoring.`);
      }
    }
    
    // RTMS session stops
    if (event === 'meeting.rtms_stopped') {
      const meetingUuid = payload.meeting_uuid;
      console.log(`RTMS session stopped for meeting: ${meetingUuid}`);
      
      // Close active connections cleanly
      if (activeConnections.has(meetingUuid)) {
        try {
          // Leave the RTMS session
          await rtms.leave();
          activeConnections.delete(meetingUuid);
          console.log(`Cleaned up connection for meeting: ${meetingUuid}`);
        } catch (error) {
          console.error(`Error cleaning up connection:`, error);
        }
      }
    }
    
    res.json({ status: 'ok' });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Zoom RTMS Webhook Server running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
});