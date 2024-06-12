const { BrowserWindow, app, ipcMain, dialog } = require("electron");
const url = require("url");
const path = require("path");
const crypto = require("crypto");

const ffmpeg = require("fluent-ffmpeg");
const { getVideoDurationInSeconds } = require("get-video-duration");

const express = require("express");
const server = express();

const cors = require("cors");
const log = require("electron-log/main");
const os = require("os");

const ffmpegStatic = path.join(
  __dirname,
  "node_modules",
  "@ffmpeg-installer",
  "win32-x64",
  "ffmpeg"
);
const fs = require("fs");

ffmpeg.setFfmpegPath(ffmpegStatic);
log.info("Log from the os", os.arch(), os.platform());

server.use("/videos", express.static(path.join(__dirname, "output")));

server.use(cors());
// Start the server
const SERVER_PORT = 3001;
server.listen(SERVER_PORT, () => {
  console.log(`Server running on http://localhost:${SERVER_PORT}`);
});
function createMainWindow() {
  const mainWindow = new BrowserWindow({
    title: "Electron",
    width: 1000,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), // Set path to preload script
      webSecurity: false,
    },
  });

  mainWindow.loadURL("http://localhost:3000");
}

let filePathString = "",
  isOptimization = false;
let listFileProgress = [];
const maxHlsTime = 10;

app.whenReady().then(createMainWindow);

// Convert time to second
function convertTimeToSeconds(timeString) {
  const parts = timeString.split(":");
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);
  const totalSecondHour = 3600;
  const totalSecondMinute = 60;

  return hours * totalSecondHour + minutes * totalSecondMinute + seconds;
}

function createOrUpdatePlaylist(
  outputDir,
  playlistPath,
  segmentPrefix,
  segmentDuration,
  totalDurationVideo
) {
  // Read the files in the output directory
  const files = fs.readdirSync(outputDir);

  // Filter files that match the segment file naming pattern (e.g., "ts.0")
  const segmentFiles = files
    .filter((file) => file.startsWith(segmentPrefix) && file.endsWith(".ts"))
    .sort((a, b) => {
      const numberA = parseInt(a.match(/(\d+)/)[1], 10);
      const numberB = parseInt(b.match(/(\d+)/)[1], 10);
      return numberA - numberB;
    });

  if (segmentFiles.length === 0) {
    // No segment files found
    console.error("No segment files found in the output directory.");
    return;
  }

  // Start creating the playlist content
  let playlistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}
#EXT-X-MEDIA-SEQUENCE:${parseInt(segmentFiles[0].match(/(\d+)/)[1], 10)}
#EXT-X-PLAYLIST-TYPE:VOD
`;

  // Add each segment to the playlist content
  segmentFiles.forEach((segmentFile, index) => {
    // Assuming each segment has the same duration except for the last one
    // For accurate duration, you would need to use ffprobe to get the actual length of each segment
    const maxFile = Math.ceil(totalDurationVideo / segmentDuration);
    if (index >= maxFile) return;
    const duration =
      index === maxFile - 1
        ? totalDurationVideo - segmentDuration * index
        : segmentDuration;
    playlistContent += `#EXTINF:${duration.toFixed(6)},\n${segmentFile}\n`;
  });

  // Finalize the playlist with the ENDLIST tag
  playlistContent += `#EXT-X-ENDLIST\n`;

  // Write the playlist to a file
  fs.writeFileSync(playlistPath, playlistContent, "utf-8");
  console.log("Playlist has been created/updated successfully.");
}

function sendMessageProgress(event, progressPercent) {
  const message = isNaN(progressPercent)
    ? "Processing..."
    : `Processing: ${Math.round(progressPercent)}% done`;

  event.sender.send("video-processing-progress", message); // Send progress update to renderer process
}

function saveDataProgress(
  filePath,
  { progress, timeMarkSecond, isOptimization }
) {
  const fileName = path.basename(filePath);
  const newListFile = listFileProgress.map((file) => {
    if (file.fileName === fileName) {
      if (progress && timeMarkSecond)
        return { ...file, progress, timeMarkSecond };
      else return { ...file, isOptimization };
    }
    return { ...file };
  });
  listFileProgress = newListFile;
  // Save data to be a file
  const jsonString = JSON.stringify(listFileProgress, null, 2);
  try {
    // Determine the output directory and create it if it doesn't exist
    const outputDir = path.join(__dirname, "/temp");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Extract the base name of the uploaded video file to use in the output file name
    const outputPlaylistPath = path.join(outputDir, `temp_file.json`);
    fs.writeFileSync(outputPlaylistPath, jsonString, "utf-8");
  } catch (err) {
    console.error("An error occurred while writing JSON to file", err);
  }
}

async function resumeOptimized(
  event,
  { duration, inputFilePath, progress: oldProgressPercent },
  segmentDuration
) {
  // Calculate the start time based on segment duration and last processed segment index

  const inputFile = path.normalize(inputFilePath);
  const originalFileName = path.basename(inputFile, path.extname(inputFile));
  const outputDir = path.join(__dirname, "/output");

  const outputPlaylistPath = path.join(
    outputDir,
    `optimized_${originalFileName}.m3u8`
  );

  // Extract the base name of the uploaded video file to use in the output file name
  const segmentFilename = `${originalFileName}_segment_%03d.ts`; // Pattern for naming the video segments

  const startTime = 0;

  // Set the start number for the next segment
  const startNumber = 0;

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Build the output path for the .m3u8 playlist
  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .outputOptions([
        "-c:v libx264",
        "-preset fast",
        "-crf 28",
        "-c:a aac",
        "-b:a 128k",
        "-f hls",
        "-g",
        (maxHlsTime * 30).toString(),
        "-start_number",
        startNumber.toString(),
        "-ss",
        startTime,
        "-hls_time",
        segmentDuration.toString(),
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        path.join(outputDir, segmentFilename), // Define segment filename pattern
      ])
      .output(outputPlaylistPath)
      .on("progress", (progress) => {
        // Handle progress updates
        console.log(
          `Processing: ${Math.max(
            oldProgressPercent,
            Number(progress.percent)
          )}% done, ${originalFileName}`
        );
      })
      .on("end", () => {
        // Handle completion
        createOrUpdatePlaylist(
          outputDir,
          outputPlaylistPath,
          originalFileName,
          maxHlsTime,
          duration
        );
        resolve("Optimized successfully");
      })
      .on("error", (err) => {
        // Handle errors
        console.error("Error during encoding:", err);
        reject("Error", err);
      })
      .run();
  });
}

app.on("window-all-closed", (event) => {
  // Save the state of ongoing video optimization tasks
  // Your logic to save the state goes here
  event.preventDefault();
  if (!isOptimization) app.quit();
  else {
    const totalProgress = listFileProgress.reduce((totalProgress, fileItem) => {
      return totalProgress + fileItem.progress;
    }, 0);
    app.quit();
  }
});

// IPC handler for selecting a file via dialog
ipcMain.handle("select-file", async () => {
  // Show an Open Dialog and return the selected file paths
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Movies",
        extensions: [
          "3g2",
          "3gp",
          "mkv",
          "avi",
          "mp4",
          "mxf",
          "mov",
          "webm",
          "wmv",
        ],
      },
    ],
  });

  if (canceled) {
    return null; // Return null if dialog is canceled
  }

  // Calculate totalDuration of files
  let totalDuration = 0;
  listFileProgress = [];
  for (const file of filePaths) {
    const duration = await getVideoDurationInSeconds(file);
    listFileProgress.push({
      fileName: path.basename(file),
      duration,
      progress: 0,
      timeMarkSecond: 0,
      isOptimization: false,
      inputFilePath: file,
    });
    totalDuration += duration;
  }

  // Return the file paths and total duration
  return { filePaths, totalDuration };
});

// IPC handler for converting the selected video file
ipcMain.handle("convert-file", async (event, filePath, totalDuration) => {
  // Get duration of video
  filePathString = "";
  isOptimization = true;
  // Determine the output directory and create it if it doesn't exist
  const outputDir = path.join(__dirname, "/output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  // Extract the base name of the uploaded video file to use in the output file name
  const originalFileName = path.basename(filePath, path.extname(filePath));
  const outputPlaylistPath = path.join(
    outputDir,
    `optimized_${originalFileName}.m3u8`
  );
  const segmentFilename = `${originalFileName}_segment_%03d.ts`; // Pattern for naming the video segments

  function generateKey() {
    return crypto.randomBytes(16); // 16 bytes = 128 bits
  }

  function saveKey(key, filePath) {
    fs.writeFileSync(filePath, key);
  }

  function createKeyInfoFile(
    cloudKeyUri,
    keyFilePath,
    keyHex,
    keyInfoFilePath
  ) {
    const keyInfoContent = `${cloudKeyUri}\n${keyFilePath}\n${keyHex}\n`;
    fs.writeFileSync(keyInfoFilePath, keyInfoContent);
  }
  const key = generateKey();
  const keyInfoFile = path.join(outputDir, "key_info");
  const keyFile = path.join(outputDir, "key.key");
  const keyHex = key.toString("hex");

  // Save key to file
  saveKey(key, path.join(outputDir, "key.key"));
  log.info("quyket", key, keyInfoFile);
  console.log("quykey", key);
  // Create key info file needed by FFmpeg
  createKeyInfoFile(
    "http://localhost:3001/videos/key.key",
    keyFile,
    keyHex,
    keyInfoFile
  );

  // Return a promise to handle the video conversion process
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .output(outputPlaylistPath) // Set the output path for the .m3u8 playlist
      .addOptions([
        // Add FFmpeg options for HLS conversion
        "-c:v libx264",
        "-preset fast",
        "-crf 28",
        "-c:a aac",
        "-b:a 128k",
        "-f hls",
        "-g",
        (maxHlsTime * 30).toString(),
        `-hls_key_info_file`,
        keyInfoFile,
        `-hls_time ${maxHlsTime}`,
        "-hls_playlist_type vod",
      ])
      .addOption("-hls_segment_filename", path.join(outputDir, segmentFilename)) // Set the naming pattern for video segments
      .on("progress", (progress) => {
        // Listen for progress updates
        const getOptimizedProgressPercent = () => {
          const { percent } = progress;
          if (percent) return percent;
          const totalProgress = listFileProgress.reduce(
            (totalPercent, fileItem) => totalPercent + fileItem.progress,
            0
          );
          return totalProgress > 100 ? 100 : totalProgress;
        };

        // Save dataProgress
        const processedTimeInSeconds = convertTimeToSeconds(progress.timemark);
        const percentOptimized = (processedTimeInSeconds * 100) / totalDuration;

        saveDataProgress(filePath, {
          progress: percentOptimized,
          timeMarkSecond: processedTimeInSeconds,
        });
        // End save dataProgress

        sendMessageProgress(event, getOptimizedProgressPercent());
      })
      .on("end", () => {
        // Listen for the conversion completion
        // Mark file be optimized
        listFileProgress.forEach((file) => {
          if (path.basename(file.fileName) === path.basename(filePath)) {
            saveDataProgress(filePath, { isOptimization: true });
          }
        });
        // Send message when optimized successfully all files
        if (
          path.basename(filePath) ===
          listFileProgress[listFileProgress.length - 1].fileName
        )
          event.sender.send(
            "video-processing-status",
            `Video optimized and converted successfully as ${outputPlaylistPath}.`
          );
        filePathString = outputPlaylistPath;
        isOptimization = false;
        resolve(
          `Video optimized and converted successfully as ${outputPlaylistPath}.`
        ); // Resolve the promise with success message
      })
      .on("error", (err) => {
        // Listen for errors during conversion
        event.sender.send(
          "video-processing-error",
          `Error during video processing: ${err.message}`
        );
        reject(`Error during video processing: ${err.message}`); // Reject the promise with error message
      })
      .run(); // Start the FFmpeg conversion process
  });
});

// IPC handler for getting temp local
ipcMain.handle("get-temp-local", async (event) => {
  const filePath = path.join(__dirname, "/temp/temp_file.json");
  try {
    // Read the file synchronously
    const data = fs.readFileSync(filePath, "utf-8");
    // Parse the JSON string into a JavaScript object
    const listFileProgress = JSON.parse(data);
    if (listFileProgress.length) {
      for (const file of listFileProgress) {
        if (!file.isOptimization) {
          console.log("file", file);
          resumeOptimized(event, file, maxHlsTime);
        }
      }
    }
    return listFileProgress;
  } catch (err) {
    return [];
  }
});
