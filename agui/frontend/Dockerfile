# Static AG-UI demo page + nginx proxy to the agui-server pods.
# Build context: agui/frontend/.   nginx:alpine is multi-arch (amd64 + arm64).
FROM nginx:1.30-alpine
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 AGUI_NAMESPACE=agents
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html app.js /usr/share/nginx/html/
EXPOSE 8080
