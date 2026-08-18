import os
import base64
import io
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

print("Starting asset generation...", flush=True)
os.makedirs('assets', exist_ok=True)

with open('plugin/ui.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Fast substring extract for base64 images
def extract_b64(marker):
    idx = html.find(marker)
    if idx == -1:
        raise ValueError(f"Marker {marker} not found")
    src_idx = html.find('src="data:image/png;base64,', idx)
    start = src_idx + len('src="data:image/png;base64,')
    end = html.find('"', start)
    return html[start:end]

brand_b64 = extract_b64('class="brand"')
star_b64 = extract_b64('class="energy-star"')

brand_img = Image.open(io.BytesIO(base64.b64decode(brand_b64))).convert("RGBA")
star_img = Image.open(io.BytesIO(base64.b64decode(star_b64))).convert("RGBA")

print(f"Extracted brand: {brand_img.size}, star: {star_img.size}", flush=True)

# 1. GENERATE LOGO.GIF
def create_logo_gif():
    print("Generating assets/logo.gif...", flush=True)
    width, height = 800, 200
    bg_color = (20, 20, 19, 255) # #141413 dark background
    
    brand_w = 600
    brand_h = int(brand_img.height * (brand_w / brand_img.width))
    scaled_brand = brand_img.resize((brand_w, brand_h), Image.Resampling.LANCZOS)
    
    brand_x = (width - brand_w) // 2
    brand_y = (height - brand_h) // 2
    
    star_target_w = 54
    star_target_h = 50
    star_x = brand_x + int(brand_w * 0.423) - (star_target_w // 2)
    star_y = brand_y + int(brand_h * 0.48) - (star_target_h // 2) - 2
    
    frames = []
    num_frames = 24
    
    for i in range(num_frames):
        t = i / num_frames
        pulse = (math.sin(t * 2 * math.pi) + 1) / 2
        scale = 0.95 + 0.12 * pulse
        brightness = 0.9 + 0.35 * pulse
        opacity = 0.85 + 0.15 * pulse
        
        frame = Image.new("RGBA", (width, height), bg_color)
        
        # Subtle green ambient glow
        glow_size = int(60 * scale)
        glow_layer = Image.new("RGBA", (width, height), (0,0,0,0))
        glow_draw = ImageDraw.Draw(glow_layer)
        glow_color = (34, 197, 94, int(40 * pulse))
        glow_draw.ellipse(
            [star_x + star_target_w//2 - glow_size, star_y + star_target_h//2 - glow_size,
             star_x + star_target_w//2 + glow_size, star_y + star_target_h//2 + glow_size],
            fill=glow_color
        )
        glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=18))
        frame.alpha_composite(glow_layer)
        
        # Brand
        frame.alpha_composite(scaled_brand, (brand_x, brand_y))
        
        # Pulsing Star
        curr_sw = int(star_target_w * scale)
        curr_sh = int(star_target_h * scale)
        s_resized = star_img.resize((curr_sw, curr_sh), Image.Resampling.BILINEAR)
        
        enhancer = ImageEnhance.Brightness(s_resized)
        s_enhanced = enhancer.enhance(brightness)
        
        r, g, b, a = s_enhanced.split()
        a = a.point(lambda p: int(p * opacity))
        s_final = Image.merge("RGBA", (r, g, b, a))
        
        curr_sx = star_x + (star_target_w - curr_sw) // 2
        curr_sy = star_y + (star_target_h - curr_sh) // 2
        frame.alpha_composite(s_final, (curr_sx, curr_sy))
        
        p_frame = frame.convert("RGB").convert("P", palette=Image.Palette.ADAPTIVE, colors=128)
        frames.append(p_frame)
        
    frames[0].save(
        'assets/logo.gif',
        save_all=True,
        append_images=frames[1:],
        duration=80,
        loop=0
    )
    print("Saved assets/logo.gif", flush=True)

# 2. GENERATE DEMO.GIF
def create_demo_gif():
    print("Generating assets/demo.gif...", flush=True)
    w, h = 600, 420
    bg = (14, 14, 13)
    win_w, win_h = 440, 360
    win_x = (w - win_w) // 2
    win_y = (h - win_h) // 2
    
    font = ImageFont.load_default()
    
    scaled_b = brand_img.resize((160, int(brand_img.height * (160/brand_img.width))), Image.Resampling.LANCZOS)
    
    frames = []
    total_frames = 40 # Fast, crisp animation
    
    for f_idx in range(total_frames):
        img = Image.new("RGBA", (w, h), bg)
        draw = ImageDraw.Draw(img)
        
        # Window Frame
        draw.rounded_rectangle([win_x, win_y, win_x + win_w, win_y + win_h], radius=10, fill=(22, 22, 21), outline=(42, 42, 40), width=1)
        
        # Window Controls
        draw.ellipse([win_x + 14, win_y + 14, win_x + 22, win_y + 22], fill=(55, 55, 53))
        draw.ellipse([win_x + 26, win_y + 14, win_x + 34, win_y + 22], fill=(55, 55, 53))
        draw.ellipse([win_x + 38, win_y + 14, win_x + 46, win_y + 22], fill=(55, 55, 53))
        draw.text((win_x + win_w - 55, win_y + 12), "v0.2.8", fill=(90, 90, 85), font=font)
        
        # Brand
        bx = win_x + (win_w - scaled_b.width) // 2
        by = win_y + 32
        img.alpha_composite(scaled_b, (bx, by))
        
        if f_idx < 22:
            # SETUP VIEW
            draw.text((win_x + 28, win_y + 76), "STEP 1", fill=(110, 110, 105), font=font)
            draw.text((win_x + 28, win_y + 90), "Copy prompt to your agent", fill=(220, 220, 215), font=font)
            
            box_rect = [win_x + 28, win_y + 110, win_x + win_w - 28, win_y + 146]
            is_copied = f_idx >= 6
            btn_fill = (28, 38, 30) if is_copied else (30, 30, 28)
            btn_border = (34, 197, 94) if is_copied else (48, 48, 45)
            draw.rounded_rectangle(box_rect, radius=6, fill=btn_fill, outline=btn_border, width=1)
            
            btn_text = "Copied to clipboard" if is_copied else "Connect to my open Figma file..."
            btn_color = (34, 197, 94) if is_copied else (170, 170, 165)
            draw.text((win_x + 40, win_y + 122), btn_text, fill=btn_color, font=font)
            
            if is_copied:
                draw.line([win_x + 28, win_y + 162, win_x + win_w - 28, win_y + 162], fill=(36, 36, 34), width=1)
                draw.text((win_x + 28, win_y + 174), "STEP 2", fill=(110, 110, 105), font=font)
                draw.text((win_x + 28, win_y + 188), "Paste the 6-digit code your agent gives you", fill=(220, 220, 215), font=font)
                
                # OTP boxes
                otp_str = ""
                if f_idx >= 10 and f_idx < 13:
                    otp_str = "95"
                elif f_idx >= 13 and f_idx < 16:
                    otp_str = "9503"
                elif f_idx >= 16:
                    otp_str = "950397"
                
                box_w = 46
                box_gap = 10
                start_x = win_x + (win_w - (6 * box_w + 5 * box_gap)) // 2
                otp_y = win_y + 212
                
                for bi in range(6):
                    r_box = [start_x + bi * (box_w + box_gap), otp_y, start_x + bi * (box_w + box_gap) + box_w, otp_y + 50]
                    has_val = bi < len(otp_str)
                    b_col = (34, 197, 94) if has_val else (48, 48, 45)
                    draw.rounded_rectangle(r_box, radius=6, fill=(28, 28, 26), outline=b_col, width=1)
                    val = otp_str[bi] if has_val else "-"
                    val_col = (240, 240, 235) if has_val else (70, 70, 65)
                    draw.text((r_box[0] + 18, r_box[1] + 17), val, fill=val_col, font=font)
                
                status_t = "Connecting..." if f_idx >= 18 else "Ready for code"
                draw.text((win_x + 28, win_y + 280), status_t, fill=(140, 140, 135), font=font)
        else:
            # CONNECTED VIEW
            c_progress = (f_idx - 22) / 18.0
            pulse = (math.sin(c_progress * 2 * math.pi) + 1) / 2
            
            # Pulsing Star
            sw = int(46 * (0.95 + 0.1 * pulse))
            sh = int(42 * (0.95 + 0.1 * pulse))
            sx = win_x + (win_w - sw) // 2
            sy = win_y + 96
            
            glow_r = int(45 * (0.9 + 0.2 * pulse))
            glow_l = Image.new("RGBA", (w, h), (0,0,0,0))
            gdraw = ImageDraw.Draw(glow_l)
            gdraw.ellipse([sx + sw//2 - glow_r, sy + sh//2 - glow_r, sx + sw//2 + glow_r, sy + sh//2 + glow_r],
                          fill=(34, 197, 94, int(45 * pulse)))
            glow_l = glow_l.filter(ImageFilter.GaussianBlur(radius=16))
            img.alpha_composite(glow_l)
            
            s_scaled = star_img.resize((sw, sh), Image.Resampling.BILINEAR)
            img.alpha_composite(s_scaled, (sx, sy))
            
            draw.text((win_x + win_w//2 - 62, win_y + 152), "CONNECTED  READY", fill=(34, 197, 94), font=font)
            
            # Metrics
            draw.line([win_x + 28, win_y + 180, win_x + win_w - 28, win_y + 180], fill=(36, 36, 34), width=1)
            col_w = (win_w - 56) // 3
            
            # Col 1
            draw.text((win_x + 28 + col_w * 0 + 24, win_y + 196), "COMMANDS", fill=(110, 110, 105), font=font)
            draw.text((win_x + 28 + col_w * 0 + 38, win_y + 214), "16", fill=(230, 230, 225), font=font)
            # Col 2
            draw.text((win_x + 28 + col_w * 1 + 28, win_y + 196), "LATENCY", fill=(110, 110, 105), font=font)
            draw.text((win_x + 28 + col_w * 1 + 36, win_y + 214), "4ms", fill=(230, 230, 225), font=font)
            # Col 3
            draw.text((win_x + 28 + col_w * 2 + 30, win_y + 196), "ERRORS", fill=(110, 110, 105), font=font)
            draw.text((win_x + 28 + col_w * 2 + 42, win_y + 214), "0", fill=(230, 230, 225), font=font)
            
            # Live document card
            doc_rect = [win_x + 36, win_y + 256, win_x + win_w - 36, win_y + 316]
            draw.rounded_rectangle(doc_rect, radius=6, fill=(28, 28, 26), outline=(42, 42, 40), width=1)
            draw.text((win_x + 50, win_y + 270), "ACTIVE FILE: app.fig", fill=(190, 190, 185), font=font)
            draw.text((win_x + 50, win_y + 288), "CURRENT SELECTION: 412x892 Frame (ID 2226:6566)", fill=(130, 130, 125), font=font)
            
        p_frame = img.convert("RGB").convert("P", palette=Image.Palette.ADAPTIVE, colors=128)
        frames.append(p_frame)
        
    frames[0].save(
        'assets/demo.gif',
        save_all=True,
        append_images=frames[1:],
        duration=120,
        loop=0
    )
    print("Saved assets/demo.gif", flush=True)

create_logo_gif()
create_demo_gif()
print("All assets generated successfully!", flush=True)
