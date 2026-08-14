# Use lightweight Node.js Alpine base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the rest of the application files
COPY . .

# Expose port 6798
EXPOSE 6798

# Start the application using Node directly (bypassing npm and --env-file in container)
CMD ["node", "index.js"]
