<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns="https://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:sitemap="https://www.sitemaps.org/schemas/sitemap/0.9">

  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html dir="rtl" lang="ar">
      <head>
        <meta charset="UTF-8"/>
        <title>خريطة الموقع | نور الحوزة</title>
        <style>
          body {
            font-family: 'Cairo', sans-serif;
            background: #fdfdfd;
            color: #333;
            padding: 2rem;
            line-height: 1.8;
            direction: rtl;
          }
          h1 {
            color: #054a29;
            font-size: 2rem;
            margin-bottom: 1.5rem;
          }
          .url {
            background: #fff;
            border-right: 5px solid #b35f2f;
            padding: 1rem 1.5rem;
            margin-bottom: 1.2rem;
            box-shadow: 0 4px 8px rgba(0,0,0,0.05);
            border-radius: 0.5rem;
          }
          .loc {
            font-weight: bold;
            font-size: 1.1rem;
            margin-bottom: 0.3rem;
            color: #222;
          }
          .meta {
            font-size: 0.9rem;
            color: #666;
          }
        </style>
      </head>
      <body>
        <h1>خريطة الموقع - نور الحوزة</h1>
        <xsl:for-each select="sitemap:urlset/sitemap:url">
          <div class="url">
            <div class="loc">
              <a href="{sitemap:loc}" target="_blank">
                <xsl:value-of select="sitemap:loc"/>
              </a>
            </div>
            <div class="meta">
              <xsl:if test="sitemap:lastmod">آخر تعديل: <xsl:value-of select="sitemap:lastmod"/> | </xsl:if>
              <xsl:if test="sitemap:changefreq">تحديث: <xsl:value-of select="sitemap:changefreq"/> | </xsl:if>
              <xsl:if test="sitemap:priority">أولوية: <xsl:value-of select="sitemap:priority"/></xsl:if>
            </div>
          </div>
        </xsl:for-each>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
