/**
 * FTP Connection Test Script
 * Tests connectivity to RoboGuide FTP server at 192.168.56.1
 * 
 * Usage: node test-ftp-connection.js
 */

const ftp = require('basic-ftp');

async function testFtpConnection() {
    const client = new ftp.Client();
    client.ftp.verbose = true;

    const config = {
        host: '192.168.56.1',
        port: 9125,
        user: 'Administrator',
        password: '',
        secure: false
    };

    try {
        console.log('🔗 Attempting FTP connection...');
        console.log(`   Host: ${config.host}:${config.port}`);
        console.log(`   User: ${config.user}`);
        console.log('');

        await client.access(config);

        console.log('✅ CONNECTION SUCCESSFUL!\n');

        // Set binary mode
        await client.send('TYPE I');
        console.log('✅ Binary mode (TYPE I) set\n');

        // List files
        console.log('📁 Listing files on robot...\n');
        const fileList = await client.list();

        if (fileList.length === 0) {
            console.log('   (No files found on robot)\n');
        } else {
            console.log('   Files:');
            fileList.forEach((file) => {
                const type = file.isFile ? '📄' : '📁';
                const size = file.isFile ? `${file.size} bytes` : '';
                console.log(`   ${type} ${file.name} ${size}`);
            });
            console.log('');
        }

        // Test info
        console.log('📊 Connection Info:');
        console.log(`   System: ${client.ftp.system || 'Unknown'}`);
        console.log(`   Features: ${client.ftp.features ? client.ftp.features.join(', ') : 'Unknown'}`);
        console.log('');

        client.close();
        console.log('✅ Connection closed successfully');
        process.exit(0);

    } catch (error) {
        console.error('❌ CONNECTION FAILED\n');
        console.error(`Error: ${error.message}\n`);

        if (error.code === 'ECONNREFUSED') {
            console.error('💡 Diagnosis: Connection refused');
            console.error('   - Robot FTP server may not be running');
            console.error('   - Check that RoboGuide FTP is enabled');
            console.error('   - Verify the IP address is correct (192.168.56.1)');
        } else if (error.code === 'ETIMEDOUT') {
            console.error('💡 Diagnosis: Connection timeout');
            console.error('   - Robot is not reachable on the network');
            console.error('   - Check virtual network adapter is connected');
            console.error('   - Verify firewall allows FTP (port 21)');
        } else if (error.code === 'ENOTFOUND') {
            console.error('💡 Diagnosis: Host not found');
            console.error('   - IP address 192.168.56.1 is not accessible');
            console.error('   - Check virtual network adapter configuration');
        } else {
            console.error('💡 Full error details:');
            console.error(error);
        }

        console.error('');
        process.exit(1);
    }
}

console.log('═══════════════════════════════════════════════════════');
console.log('  Robot FTP Connection Test');
console.log('═══════════════════════════════════════════════════════\n');

testFtpConnection();
