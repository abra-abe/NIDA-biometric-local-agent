import base64
from PIL import Image
import wsq  # IMPORTANT: Import wsq to register the plugin with Pillow

with open("image_base64.txt", "r") as f:
    b64_data = f.read()

wsq_bytes = base64.b64decode(b64_data)

with open("output.wsq", "wb") as f:
    f.write(wsq_bytes)

# display the image
img = Image.open("output.wsq")
img.show()