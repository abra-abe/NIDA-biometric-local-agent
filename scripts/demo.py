import os
import time
import base64
from datetime import datetime
from PIL import Image 
import wsq             # IMPORTANT: Import wsq to register the plugin with Pillow
import io              # To capture WSQ bytes in memory
from pyzkfp import ZKFP2

# Initialize the ZKFP2 class
zkfp2 = ZKFP2()

# Initialize the device
zkfp2.Init()

# Get device count and open the first device
device_count = zkfp2.GetDeviceCount()
if device_count == 0:
    print("No fingerprint device found.")
    exit()
zkfp2.OpenDevice(0)

# Create directory to save images
save_path = 'fingerprints'
os.makedirs(save_path, exist_ok=True)

print("Place your finger on the scanner...")

# --- Fingerprint Image Properties ---
# These are CRUCIAL for Pillow understanding the raw data
FINGERPRINT_WIDTH = 288  # Example Width
FINGERPRINT_HEIGHT = 375 # Example Height
FINGERPRINT_MODE = 'L'   # Grayscale mode ('L' for 8-bit pixels, black and white)
# ---

try:
    while True:
        capture = zkfp2.AcquireFingerprint()

        if capture:
            tmp, img_data_raw = capture # Contains raw image bytes

            # Ensure img_data_raw is bytes
            img_data_bytes = bytes(img_data_raw)

            # --- Process and Save Images using Pillow ---
            try:
                # 1. Create Pillow Image object from raw data
                img_pil = Image.frombytes(FINGERPRINT_MODE, (FINGERPRINT_WIDTH, FINGERPRINT_HEIGHT), img_data_bytes, 'raw')

                # Optional: Display image using Pillow's method or zkfp2's
                # img_pil.show()
                # zkfp2.show_image(img_data_raw)

                # Ensure image is grayscale (as recommended by wsq docs)
                # Although FINGERPRINT_MODE='L' should already be grayscale,
                # this ensures compatibility if the mode was different.
                img_pil = img_pil.convert("L")

                # Generate timestamp only once
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                base_filename = f'fingerprint_{timestamp}'

                # 2. Save as PNG (Standard Pillow operation)
                png_file_name = f'{base_filename}.png'
                png_file_path = os.path.join(save_path, png_file_name)
                img_pil.save(png_file_path, 'PNG')
                print(f"PNG Image saved: {png_file_path}")

                # 3. Save as WSQ (using Pillow, enabled by 'import wsq')
                wsq_file_name = f'{base_filename}.wsq'
                wsq_file_path = os.path.join(save_path, wsq_file_name)
                # Pillow automatically recognizes .wsq OR you can specify format='WSQ'
                img_pil.save(wsq_file_path) # Relies on file extension
                # Or explicitly: img_pil.save(wsq_file_path, format='WSQ')
                print(f"WSQ Image saved: {wsq_file_path}")

                # 4. Get WSQ image bytes for Base64 encoding (without re-reading file)
                wsq_buffer = io.BytesIO()
                img_pil.save(wsq_buffer, format='WSQ') # Save to in-memory buffer
                wsq_data = wsq_buffer.getvalue()      # Get bytes from buffer

                # 5. Prepare WSQ Base64 Output for Node.js
                wsq_b64 = base64.b64encode(wsq_data).decode('utf-8')
                png_b64 = base64.b64encode(open(png_file_path, 'rb').read()).decode('utf-8')

                # --- Print ONLY the WSQ Base64 data for Node.js ---
                print(f"FINGERPRINT_WSQ_B64:{wsq_b64}")
                # print(f"FINGERPRINT_PNG_B64:{png_b64}")

                # --- Fingerprint Template Processing (Commented Out) ---
                # template_bytes = bytes(tmp)
                # template_b64 = base64.b64encode(template_bytes).decode('utf-8')
                # print(f"FINGERPRINT_TEMPLATE: {template_b64}")
                # ---

                break # Exit the loop after successful capture and processing

            except Exception as img_e:
                print(f"Error processing/saving image with Pillow/WSQ: {img_e}")
                print("Please ensure FINGERPRINT_WIDTH and FINGERPRINT_HEIGHT are correct.")
                break # Exit loop on image processing error

        time.sleep(0.2) # Wait before next capture attempt

except Exception as e:
    print(f"Error: {e}")

finally:
    zkfp2.Terminate()
    print("Device terminated.")