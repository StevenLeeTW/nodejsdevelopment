var https = require('https'),
    express = require('express'),
    fortune = require('./lib/fortune.js'),
    formidable = require('formidable'),
    fs = require('fs'),
    vhost = require('vhost'),
    Vacation = require('./models/vacation.js'),
    VacationInSeasonListener = require('./models/vacationInSeasonListener.js');

var app = express();

var credentials = require('./credentials.js');

var emailService = require('./lib/email.js')(credentials);

// set up handlebars view engine
var handlebars = require('express3-handlebars').create({
    defaultLayout:'main',
    helpers: {
        section: function(name, options){
            if(!this._sections) this._sections = {};
            this._sections[name] = options.fn(this);
            return null;
        },
        static: function(name) {
            return require('./lib/static.js').map(name);
        }
    }
});
app.engine('handlebars', handlebars.engine);
app.set('view engine', 'handlebars');

// set up css/js bundling
var bundler = require('connect-bundle')(require('./config.js'));
app.use(bundler);

app.set('port', process.env.PORT || 3000);

// use domains for better error handling
app.use(function(req, res, next){
    // create a domain for this request
    var domain = require('domain').create();
    // handle errors on this domain
    domain.on('error', function(err){
        console.error('DOMAIN ERROR CAUGHT\n', err.stack);
        try {
            // failsafe shutdown in 5 seconds
            setTimeout(function(){
                console.error('Failsafe shutdown.');
                process.exit(1);
            }, 5000);

            // disconnect from the cluster
            var worker = require('cluster').worker;
            if(worker) worker.disconnect();

            // stop taking new requests
            server.close();

            try {
                // attempt to use Express error route
                next(err);
            } catch(error){
                // if Express error route failed, try
                // plain Node response
                console.error('Express error mechanism failed.\n', error.stack);
                res.statusCode = 500;
                res.setHeader('content-type', 'text/plain');
                res.end('Server error.');
            }
        } catch(error){
            console.error('Unable to send 500 response.\n', error.stack);
        }
    });

    // add the request and response objects to the domain
    domain.add(req);
    domain.add(res);

    // execute the rest of the request chain in the domain
    domain.run(next);
});

//logging
switch(app.get('env')){    
    case 'development':
            // compact, colorful dev logging        
            app.use(require('morgan')('dev'));        
            break;    
    case 'production':        
            // module 'express-logger' supports daily log rotation        
            app.use(require('express-logger')({
            f: __dirname + '/log/requests.log'
            }));        
            break;
}

var MongoSessionStore = require('session-mongoose')(require('connect'));
var sessionStore = new MongoSessionStore({ url: credentials.mongo[app.get('env')].connectionString });

app.use(require('body-parser')());
app.use(require('cookie-parser')(credentials.cookieSecret));
app.use(require('express-session')({
    resave: false,
    saveUninitialized: false,
    secret: credentials.cookieSecret,
}));
app.use(require('csurf')());
app.use(function(req, res, next) {
    res.locals._csrfToken = req.csrfToken();
    next();
});

app.use(express.static(__dirname + '/public'));

app.use(require('body-parser')());

// database configuration
var mongoose = require('mongoose');
var options = {
    server: {
       socketOptions: { keepAlive: 1 } 
    }
};
switch(app.get('env')){
    case 'development':
        mongoose.connect(credentials.mongo.development.connectionString, options);
        break;
    case 'production':
        mongoose.connect(credentials.mongo.production.connectionString, options);
        break;
    default:
        throw new Error('Unknown execution environment: ' + app.get('env'));
}

// initialize vacations
Vacation.find(function(err, vacations){
    if(vacations.length) return;

    new Vacation({
        name: 'Hood River Day Trip',
        slug: 'hood-river-day-trip',
        category: 'Day Trip',
        sku: 'HR199',
        description: 'Spend a day sailing on the Columbia and ' + 
            'enjoying craft beers in Hood River!',
        priceInCents: 9995,
        tags: ['day trip', 'hood river', 'sailing', 'windsurfing', 'breweries'],
        inSeason: true,
        maximumGuests: 16,
        available: true,
        packagesSold: 0,
    }).save();

    new Vacation({
        name: 'Oregon Coast Getaway',
        slug: 'oregon-coast-getaway',
        category: 'Weekend Getaway',
        sku: 'OC39',
        description: 'Enjoy the ocean air and quaint coastal towns!',
        priceInCents: 269995,
        tags: ['weekend getaway', 'oregon coast', 'beachcombing'],
        inSeason: false,
        maximumGuests: 8,
        available: true,
        packagesSold: 0,
    }).save();

    new Vacation({
        name: 'Rock Climbing in Bend',
        slug: 'rock-climbing-in-bend',
        category: 'Adventure',
        sku: 'B99',
        description: 'Experience the thrill of rock climbing in the high desert.',
        priceInCents: 289995,
        tags: ['weekend getaway', 'bend', 'high desert', 'rock climbing', 'hiking', 'skiing'],
        inSeason: true,
        requiresWaiver: true,
        maximumGuests: 4,
        available: false,
        packagesSold: 0,
        notes: 'The tour guide is currently recovering from a skiing accident.',
    }).save();
});

// flash message middleware
app.use(function(req, res, next){        
// if there's a flash message, transfer it to the context, then clear it   
             res.locals.flash = req.session.flash;
             delete req.session.flash; 
             next(); 
         });

app.use(function(req, res, next) { // it must appear before we define any routes in which we wish to use it
    res.locals.showTests = app.get('env') !== 'production' &&
        req.query.test === '1';
    next();
});

function getWeatherData(){
    return {
        locations: [
            {
                name: 'Portland',
                forecastUrl: 'http://www.wunderground.com/US/OR/Portland.html',
                iconUrl: 'http://icons-ak.wxug.com/i/c/k/cloudy.gif',
                weather: 'Overcast',
                temp: '54.1 F (12.3 C)',
            },
            {
                name: 'Bend',
                forecastUrl: 'http://www.wunderground.com/US/OR/Bend.html',
                iconUrl: 'http://icons-ak.wxug.com/i/c/k/partlycloudy.gif',
                weather: 'Partly Cloudy',
                temp: '55.0 F (12.8 C)',
            },
            {
                name: 'Manzanita',
                forecastUrl: 'http://www.wunderground.com/US/OR/Manzanita.html',
                iconUrl: 'http://icons-ak.wxug.com/i/c/k/rain.gif',
                weather: 'Light Rain',
                temp: '55.0 F (12.8 C)',
            },
        ],
    };
}
app.use(function(req, res, next){
    if(!res.locals.partials) res.locals.partials = {};
    res.locals.partials.weatherContext = getWeatherData();
    next();
});

// middleware to handle logo image easter eggs
var static = require('./lib/static.js').map;
app.use(function(req, res, next){
    var now = new Date();
    res.locals.logoImage = now.getMonth()==2 && now.getDate()==26 ?
    static('/img/logo_bud_clark.png') :
    static('/img/logo.png');
    next();
});

// create "admin" subdomain...this should appear
// before all your other routes
var admin = express.Router();
app.use(require('vhost')('admin.*', admin));

// create admin routes; these can be defined anywhere
admin.get('/', function(req, res){
    res.render('admin/home');
});
admin.get('/users', function(req, res){
    res.render('admin/users');
});



//jQuery File Upload endpoint middleware 
app.use('/upload', function(req, res, next){

    var now = Date.now();
    jqupload.fileHandler({
        uploadDir: function(){
            return __dirname + '/public/uploads/' + now;
        },
        uploadUrl: function(){
            return '/uploads/' + now;
        },
    })(req, res, next);
});

// add routes
require('./routes.js')(app);

var Attraction = require('./models/attraction.js');


app.get('/attractions', function(req, content, cb){
    Attraction.find({ approved: true }, function(err, attractions){
        if(err) return cb({ error: 'Internal error.' });
        cb(null, attractions.map(function(a){
            return {
                name: a.name,
                description: a.description,
                location: a.location,
            };
        }));
    });
});

app.post('/attraction', function(req, content, cb){
    var a = new Attraction({
        name: req.body.name,
        description: req.body.description,
        location: { lat: req.body.lat, lng: req.body.lng },
        history: {
            event: 'created',
            email: req.body.email,
            date: new Date(),
        },
        approved: false,
    });
    a.save(function(err, a){
        if(err) return cb({ error: 'Unable to add attraction.' });
        cb(null, { id: a._id });
    }); 
});

app.get('/attraction/:id', function(req, content, cb){
    Attraction.findById(req.params.id, function(err, a){
        if(err) return cb({ error: 'Unable to retrieve attraction.' });
        cb(null, { 
            name: a.name,
            description: a.description,
            location: a.location,
        });
    });
});

// authentication
var auth = require('./lib/auth.js')(app, {
    baseUrl: process.env.BASE_URL,
    providers: credentials.authProviders,
    successRedirect: '/account',
    failureRedirect: '/unauthorized',
});
// auth.init() links in Passport middleware:
auth.init();

// now we can specify our auth routes:
auth.registerRoutes();

// authorization helpers
function customerOnly(req, res, next){
    if(req.user && req.user.role==='customer') return next();
    // we want customer-only pages to know they need to logon
    res.redirect(303, '/unauthorized');
}
function employeeOnly(req, res, next){
    if(req.user && req.user.role==='employee') return next();
    // we want employee-only authorization failures to be "hidden", to
    // prevent potential hackers from even knowhing that such a page exists
    next('route');
}
function allow(roles) {
    return function(req, res, next) {
        if(req.user && roles.split(',').indexOf(req.user.role)!==-1) 
            return next();
        res.redirect(303, '/unauthorized');
    };
}

app.get('/unauthorized', function(req, res) {
    res.status(403).render('unauthorized');
});

// customer routes

app.get('/account', allow('customer,employee'), function(req, res){
    res.render('account', { username: req.user.name });
});
app.get('/account/order-history', customerOnly, function(req, res){
    res.render('account/order-history');
});
app.get('/account/email-prefs', customerOnly, function(req, res){
    res.render('account/email-prefs');
});

// employer routes
app.get('/sales', employeeOnly, function(req, res){
    res.render('sales');
});


// add support for auto views
var autoViews = {};

app.use(function(req,res,next){
    var path = req.path.toLowerCase();  
    // check cache; if it's there, render the view
    if(autoViews[path]) return res.render(autoViews[path]);
    // if it's not in the cache, see if there's
    // a .handlebars file that matches
    if(fs.existsSync(__dirname + '/views' + path + '.handlebars')){
        autoViews[path] = path.replace(/^\//, '');
        return res.render(autoViews[path]);
    }
    // no view found; pass on to 404 handler
    next();
});


//custom 404 page
app.use(function(req, res, next) {
    res.status(404);
    res.render('404');


});

//custom 500 page
app.use(function(err, req, res, next) {
    console.error(err.stack);
//    res.status(500);
//    res.render('500'); replace it with one line
    res.status(500);
    res.render('500');
});




/*app.listen(app.get('port'), function() {
    console.log('Express started on http://localhost:' + app.get('port') + '; press Ctrl-C to terminate');
});
*/

var server;

function startServer() {
    var keyFile = __dirname + '/ssl/app.pem',
        certFile = __dirname + '/ssl/app.crt';
    if(!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
        console.error('\n\nERROR: One or both of the SSL cert or key are missing:\n' +
            '\t' + keyFile + '\n' +
            '\t' + certFile + '\n' +
            'You can generate these files using openssl; please refer to the book for instructions.\n');
        process.exit(1);
    }
    var options = {
        key: fs.readFileSync(__dirname + '/ssl/app.pem'),
        cert: fs.readFileSync(__dirname + '/ssl/app.crt'),
    };
    server = https.createServer(options, app).listen(app.get('port'), function(){
      console.log( 'Express started in ' + app.get('env') +
        ' mode on port ' + app.get('port') + ' using HTTPS' +
        '; press Ctrl-C to terminate.' );
    });
}

if(require.main === module){
    // application run directly; start app server
    startServer();
} else {
    // application imported as a module via "require": export function to create server
    module.exports = startServer;
}