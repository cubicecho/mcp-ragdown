// Eleventy config for the mcp-ragdown landing/docs site.
// Output is deployed to GitHub Pages at https://cubicecho.github.io/mcp-ragdown/,
// so everything is served under the /mcp-ragdown/ path prefix. Use the `| url`
// filter on every internal link/asset so paths stay correct there and in dev.

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({'src/css': 'css'});
  eleventyConfig.addPassthroughCopy({'src/assets': 'assets'});
  eleventyConfig.addPassthroughCopy({'src/nojekyll': '.nojekyll'});

  eleventyConfig.addFilter('year', () => '2026');

  eleventyConfig.setServerOptions({
    showAllHosts: true,
    host: '0.0.0.0',
    port: 3000
  });

  return {
    dir: {
      input: 'src',
      output: '_site',
      includes: '_includes',
      data: '_data',
    },
    pathPrefix: '/mcp-ragdown/',
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
    templateFormats: ['njk', 'md'],
  };
}
