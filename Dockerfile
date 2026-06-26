FROM node:18

# Buat user baru agar aman di platform Hugging Face
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR /app

# Salin package.json dan pasang dependencies
COPY --chown=user package*.json ./
RUN npm install

# Salin seluruh file project
COPY --chown=user . .

# Hugging Face WAJIB mendengarkan port 7860
EXPOSE 7860

# Jalankan server
CMD ["node", "server.js"]
