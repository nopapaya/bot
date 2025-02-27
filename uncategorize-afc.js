#!/usr/bin/env node

// Dependencies.
const argv = require('minimist')(process.argv.slice(2));
const MWBot = require('mwbot');
const mysql = require('mysql');
const util = require('util');

const credentials = require('./credentials'); // Load credentials from config.
const apiUrl = 'https://zh.wikipedia.org/w/api.php';
const database = 'zhwiki_p';
const editSummary = 'Task 3: Disable the categories on this page while it is still a draft, per [[WP:DRAFTNOCAT]]/[[WP:USERNOCAT]]';

/**
 * Log a message to stdout prepended with a timestamp.
 * @param {String} message
 */
function log(message) {
    const datestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    console.log(`${datestamp}: ${message}`);
}

/**
 * Connect to the replicas.
 * @returns {Connection} A new MySQL connection.
 */
function getReplicaConnection() {
    log('Establishing connection to the replicas (AfC)');
    const connection = mysql.createConnection({
        host: credentials.db_host,
        port: credentials.db_port,
        user: credentials.db_user,
        password: credentials.db_password,
        database: credentials.db_database
    });
    connection.connect();
    return connection;
}

/**
 * Query the replicas to get the categorized drafts.
 * @returns {Array} Result of query.
 */
async function getCategorizedDrafts() {
    const connection = getReplicaConnection();

    log('Running query to fetch categorized afc submissions');
    const sql = `
       SELECT page.page_id AS ID, page.page_namespace AS ns, page.page_title AS title FROM categorylinks
       JOIN page ON page_id = cl_from
       WHERE cl_to = 'AfC_submissions_with_categories'
       AND page_namespace in (2, 118)
       AND page_is_redirect = 0`;

    // Make database query synchronous.
    const fn = util.promisify(connection.query).bind(connection);
    return await fn(sql);
}

/**
 * Remove the categories of a page
 * @param {MWBot} bot
 * @param {Object} row
 * @param {Bool} dryRun
 * @returns {Promise<void>|void}
 */
async function uncategorizePage( bot, row, dryRun ) {
  const ns = parseInt( row.ns );
  const nsTitlePrefix = ( ns === 2 ) ? 'User:' : 'Draft:';
  const title = nsTitlePrefix + row.title;

  const pageID = parseInt( row.ID );
  const queryResult = await bot.read( title, true ); // true = don't follow redirects
  const content = queryResult.query.pages[ pageID ].revisions[ 0 ][ '*' ];
  
  // Ensure that draft categories, and categories in {{Draft categories}}, don't match
  const ignoredCategories = content.match(/{{Draft categories\|[^{}]+}}/i);
  const toPutBack = ( ignoredCategories && ignoredCategories[0] ) || '';
  var newContent = content.replace(/{{Draft categories\|[^{}]+}}/i, 'PUTTHEIGNOREDCATEGORIESBACKHERE');
  newContent = newContent.replace( /\[\[Category:(?!(?:Draft|.*?drafts\]\]))/gi, '\[\[:Category:' );
  newContent = newContent.replace( 'PUTTHEIGNOREDCATEGORIESBACKHERE', toPutBack );

  if ( dryRun ) {
    console.log( title, content, newContent );
    return;
  } else {
    return await bot.update( title, newContent, editSummary, { minor: true } );
  }
}

/**
 * Create and return a bot instance
 * @returns {MWBot}
 */
async function botLogin() {
  // Login to the bot.
    log(`Logging in to bot account`);
    const bot = new MWBot({apiUrl});
    await bot.loginGetEditToken({
        apiUrl,
        username: credentials.username,
        password: credentials.password
    });

    return bot;
}

/**
 * Entry point for the bot task.
 * @returns {Promise<void>}
 */
async function main() {
    const bot = await botLogin();
    const drafts = await getCategorizedDrafts();
    var dry;
    if ( argv.dry ) {
      dry = true;
    } else {
      dry = false
    }
    
    for ( var iii = 0; iii < drafts.length; iii++ ) {
      await uncategorizePage( bot, drafts[iii], dry )
    }

    log('Task complete!');
    process.exit();
}

main().catch(console.error);
